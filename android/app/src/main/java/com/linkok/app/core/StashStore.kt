package com.linkok.app.core

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import android.util.Log
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Stash 中的一条 Capture。
 *
 * 术语见 CONTEXT.md：Stash / Capture / Arrival Time / Save / Discard。
 * 字段与 docs/PROTOCOL.md §4 的 PC HistoryItem 平行。
 */
data class StashItem(
    val id: String,
    val sha256: String,
    val arrivedAt: Instant,
    val fileName: String,
    val bytes: Long,
    val width: Int = 0,
    val height: Int = 0,
    /** 非空表示已 Save 过（正常流程下此时条目已被移除，仅用于崩溃恢复）。 */
    val savedAt: Instant? = null,
) {
    val file: File get() = File(fileName)
}

/**
 * 手机端的临时暂存区。
 *
 * 两条硬约束（见 SPEC §5.3 / PROTOCOL.md §10）：
 * 1. Stash 不是系统相册；Save 是「搬走」，不是「复制」。
 * 2. 除 Retention 外，Stash 另有 500MB 容量上限，超出从最旧开始清。
 *    这条独立于 retentionDays —— 即使设为「永不」也生效。
 */
class StashStore(private val context: Context) {

    private val dir: File by lazy {
        File(context.filesDir, "stash").apply { mkdirs() }
    }
    private val indexFile: File by lazy { File(context.filesDir, "stash/index.json") }
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        private const val TAG = "StashStore"
        /** 500MB 容量上限。 */
        const val CAPACITY_BYTES = 500L * 1024 * 1024
        private val ID_TIME_FORMAT =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmssSSS").withZone(ZoneId.of("UTC"))
    }

    suspend fun list(): List<StashItem> = withContext(Dispatchers.IO) {
        val indexed = readIndex()
        // 自愈：磁盘上有 PNG 但索引里没有的孤儿文件，补回索引。
        //
        // 为什么需要：早期版本的索引解析 bug 会静默丢弃条目（见 parseOptionalInstant
        // 的注释），结果是磁盘上 4 张图、索引里只剩 1 条，界面显示"还没有收到截图"，
        // 而文件其实都在。这里按文件名重建条目，把这些图救回来。
        val recovered = recoverOrphans(indexed)
        val all = if (recovered.isEmpty()) indexed else {
            val merged = indexed + recovered
            writeIndex(merged)
            merged
        }
        all.sortedByDescending { it.arrivedAt }
    }

    /** 找出磁盘上存在但索引里没有的 PNG，按文件名重建条目。 */
    private fun recoverOrphans(indexed: List<StashItem>): List<StashItem> {
        val known = indexed.map { File(it.fileName).name }.toHashSet()
        val orphans = dir.listFiles { f -> f.isFile && f.name.endsWith(".png") }
            ?.filter { it.name !in known }
            ?: return emptyList()
        if (orphans.isEmpty()) return emptyList()

        val recovered = orphans.mapNotNull { f ->
            runCatching {
                val bytes = f.readBytes()
                val hash = sha256Hex(bytes)
                // 文件名形如 <UTC紧凑时间>-<hash前6>.png
                val base = f.nameWithoutExtension
                val timePart = base.substringBeforeLast('-')
                val arrivedAt = runCatching {
                    java.time.LocalDateTime.parse(
                        timePart,
                        java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmssSSS")
                    ).atZone(java.time.ZoneOffset.UTC).toInstant()
                }.getOrElse { Instant.ofEpochMilli(f.lastModified()) }

                StashItem(
                    id = base,
                    sha256 = hash,
                    arrivedAt = arrivedAt,
                    fileName = f.absolutePath,
                    bytes = bytes.size.toLong(),
                )
            }.getOrElse {
                Log.w(TAG, "孤儿文件无法重建：${f.name}", it)
                null
            }
        }
        if (recovered.isNotEmpty()) {
            Log.i(TAG, "从磁盘恢复了 ${recovered.size} 个未索引的截图")
        }
        return recovered
    }

    /**
     * 存入一张图。返回 null 表示是重复（同 hash 已存在），未落盘。
     *
     * @param png PNG 字节。调用方负责保证格式与大小（单张上限 20MB）。
     */
    suspend fun put(png: ByteArray, width: Int, height: Int): StashItem? =
        withContext(Dispatchers.IO) {
            val hash = sha256Hex(png)
            val existing = readIndex()
            if (existing.any { it.sha256 == hash }) return@withContext null

            val arrivedAt = Instant.now()
            val id = "${ID_TIME_FORMAT.format(arrivedAt)}-${hash.take(6)}"
            val stored = File(dir, "$id.png")
            stored.writeBytes(png)

            val item = StashItem(
                id = id,
                sha256 = hash,
                arrivedAt = arrivedAt,
                fileName = stored.absolutePath,
                bytes = png.size.toLong(),
                width = width,
                height = height,
            )
            val next = existing + item
            writeIndex(next)
            enforceCapacity(next)
            item
        }

    /**
     * Save：把这张图搬进系统相册，然后从 Stash 移除。
     * 返回 true 表示成功。失败时保留原条目，不丢数据。
     */
    suspend fun save(item: StashItem, saveToGallery: suspend (File, String) -> Boolean): Boolean =
        withContext(Dispatchers.IO) {
            val src = File(item.fileName)
            if (!src.exists()) {
                // 文件已不在，直接剔除索引，避免留死条目。
                removeFromIndex(item.id)
                return@withContext false
            }
            val ok = saveToGallery(src, "LinkOK_${item.id}")
            if (ok) {
                // 搬走：相册写入成功后删除 Stash 里的副本，不产生双份。
                src.delete()
                removeFromIndex(item.id)
            }
            ok
        }

    suspend fun discard(item: StashItem) = withContext(Dispatchers.IO) {
        File(item.fileName).delete()
        removeFromIndex(item.id)
    }

    suspend fun discardAll(items: List<StashItem>) = withContext(Dispatchers.IO) {
        val ids = items.map { it.id }.toSet()
        items.forEach { File(it.fileName).delete() }
        val remaining = readIndex().filterNot { it.id in ids }
        writeIndex(remaining)
    }

    /** 按 Retention 清理。days = 0 表示永不。返回删除条数。 */
    suspend fun sweepRetention(days: Int): Int = withContext(Dispatchers.IO) {
        if (days <= 0) return@withContext 0
        val cutoff = Instant.now().minusSeconds(days.toLong() * 24 * 3600)
        val all = readIndex()
        val (expired, keep) = all.partition { it.arrivedAt.isBefore(cutoff) }
        expired.forEach { File(it.fileName).delete() }
        if (expired.isNotEmpty()) writeIndex(keep)
        expired.size
    }

    suspend fun totalBytes(): Long = withContext(Dispatchers.IO) {
        readIndex().sumOf { it.bytes }
    }

    // ── 内部 ──────────────────────────────────────────────

    /** 容量保护：超出上限时从最旧开始删。与 retentionDays 无关，始终生效。 */
    private fun enforceCapacity(items: List<StashItem>) {
        var total = items.sumOf { it.bytes }
        if (total <= CAPACITY_BYTES) return
        val byAge = items.sortedBy { it.arrivedAt }
        val removed = mutableSetOf<String>()
        for (item in byAge) {
            if (total <= CAPACITY_BYTES) break
            File(item.fileName).delete()
            removed += item.id
            total -= item.bytes
        }
        if (removed.isNotEmpty()) {
            writeIndex(items.filterNot { it.id in removed })
        }
    }

    private fun readIndex(): List<StashItem> {
        if (!indexFile.exists()) return emptyList()
        return runCatching {
            val root = json.parseToJsonElement(indexFile.readText()).jsonObject
            root["items"]?.jsonArray?.mapNotNull { el ->
                val o = el.jsonObject
                runCatching {
                    StashItem(
                        id = o["id"]!!.jsonPrimitive.content,
                        sha256 = o["sha256"]!!.jsonPrimitive.content,
                        arrivedAt = Instant.parse(o["arrivedAt"]!!.jsonPrimitive.content),
                        fileName = o["fileName"]!!.jsonPrimitive.content,
                        bytes = o["bytes"]!!.jsonPrimitive.long,
                        width = o["width"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                        height = o["height"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                        savedAt = parseOptionalInstant(o["savedAt"]?.jsonPrimitive?.contentOrNull),
                    )
                }.getOrElse {
                    // 单条解析失败不该静默消失 —— 之前这里吞掉异常，导致
                    // 索引里的历史条目一条条"蒸发"，磁盘上有文件但界面显示空。
                    Log.w(TAG, "Stash 条目解析失败，跳过：$o", it)
                    null
                }
            } ?: emptyList()
        }.getOrElse {
            Log.e(TAG, "索引读取失败", it)
            emptyList()
        }
    }

    /**
     * 解析可选的 Instant 字段。
     *
     * 必须同时容忍 null、空字符串、以及字面量 "null" ——
     * 早期 writeIndex 把「没有 savedAt」写成 `""`，而旧代码用
     * `takeIf { it != "null" }` 判断，空字符串会通过判断然后
     * `Instant.parse("")` 抛异常，被 runCatching 吞掉后整条记录被丢弃。
     * 结果就是：磁盘上有 4 张图，index.json 里只剩最后 1 条。
     */
    private fun parseOptionalInstant(raw: String?): Instant? {
        if (raw.isNullOrBlank() || raw == "null") return null
        return runCatching { Instant.parse(raw) }.getOrNull()
    }

    /**
     * 原子写入索引：先写 .tmp，再 rename 覆盖。
     * 断电或进程被杀时，不会留下半截 JSON。
     */
    private fun writeIndex(items: List<StashItem>) {
        indexFile.parentFile?.mkdirs()
        val payload = buildJsonObject {
            put("version", 1)
            put("items", kotlinx.serialization.json.JsonArray(items.map { it.toJson() }))
        }
        val tmp = File(indexFile.parentFile, "index.json.tmp")
        tmp.writeText(payload.toString())
        if (indexFile.exists()) indexFile.delete()
        if (!tmp.renameTo(indexFile)) {
            // rename 失败时退化为直接拷贝，绝不静默丢弃。
            indexFile.writeText(payload.toString())
            tmp.delete()
        }
    }

    private fun StashItem.toJson() = buildJsonObject {
        put("id", id)
        put("sha256", sha256)
        put("arrivedAt", arrivedAt.toString())
        put("fileName", fileName)
        put("bytes", bytes)
        put("width", width)
        put("height", height)
        // 没有 savedAt 时写真正的 JSON null，而不是空字符串。
        // 空字符串会诱使读取端 Instant.parse("") 抛异常（旧 bug 的成因）。
        if (savedAt != null) {
            put("savedAt", savedAt.toString())
        } else {
            put("savedAt", kotlinx.serialization.json.JsonNull)
        }
    }

    private fun removeFromIndex(id: String) {
        writeIndex(readIndex().filterNot { it.id == id })
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    /** 生成一个新的 UUID 文件名，供下载临时中转使用。 */
    fun newTempFile(): File = File(dir, "tmp-${UUID.randomUUID()}.png")
}
