package com.linkok.app.core

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * LinkOK 本地日志。
 *
 * 为什么需要：手机端的 61 处 `Log.*` 全部只进 logcat，而 MIUI 会屏蔽 logcat
 * （排查时 `adb logcat` 经常是空的）。出了问题用户拿不到任何线索，
 * 只能靠猜。
 *
 * 设计要点：
 *
 * 1. **级别**沿用标准的五级（VERBOSE/DEBUG/INFO/WARN/ERROR），
 *    默认发版级别是 INFO —— DEBUG 里的逐帧解码之类的噪声不落盘。
 *
 * 2. **体积**用两道闸门控制，不靠"希望不会太大"：
 *    - 单文件上限 [MAX_FILE_BYTES]（512 KB），超过就切分片
 *    - 分片数与天数双重上限（最多 [MAX_FILES] 个），更早的自动删
 *    加起来磁盘占用上限约 2.5 MB，对手机可忽略。
 *
 * 3. **异步**：写盘在单线程池里排队。日志不能拖慢主流程，
 *    但也不能因为异步而丢关键错误 —— 队列有界，满了就丢弃并计数，
 *    下次写日志时补一行"已丢弃 N 条"，而不是静默。
 *
 * 4. **可导出**：用户可以在设置页把日志分享出来（调试的核心需求）。
 */
object AppLog {

    /** 日志级别。数值越大越严重，与 logcat 的约定一致。 */
    enum class Level(val tag: String, val weight: Int) {
        VERBOSE("V", 10),
        DEBUG("D", 20),
        INFO("I", 30),
        WARN("W", 40),
        ERROR("E", 50),
    }

    /** 单文件上限 512 KB。超过就切下一个分片。 */
    private const val MAX_FILE_BYTES = 512 * 1024L
    /** 最多保留多少个分片文件（含当前）。 */
    private const val MAX_FILES = 5
    /** 异步队列上限。满了丢弃并计数。 */
    private const val MAX_QUEUE = 512

    private val timeFormat = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
    private val fileFormat = SimpleDateFormat("yyyyMMdd", Locale.US)

    private var logDir: File? = null
    private var currentFile: File? = null
    private var currentBytes = 0L
    private var currentDay = ""

    /** 当前生效的最低级别。release 用 INFO，debug 构建可用 DEBUG。 */
    @Volatile
    private var minLevel = Level.INFO

    @Volatile
    private var initialized = false

    private val pending = ArrayDeque<String>()
    private val dropped = AtomicLong(0)
    private val lock = Any()

    private val writer = Executors.newSingleThreadExecutor { r ->
        Thread(r, "LinkOK-LogWriter").apply { isDaemon = true }
    }

    /**
     * 初始化。必须在 Application/Service 最早的位置调用。
     *
     * @param dir 日志目录，通常是 `context.filesDir/logs`
     * @param debug 是否使用 DEBUG 级别
     */
    fun init(context: Context, debug: Boolean = false) {
        if (initialized) return
        synchronized(lock) {
            if (initialized) return
            minLevel = if (debug) Level.DEBUG else Level.INFO
            logDir = File(context.filesDir, "logs").apply { mkdirs() }
            rotateIfNeeded(force = true)
            initialized = true
        }
    }

    /** 运行期调整级别（设置页可开关"详细日志"）。 */
    fun setDebugEnabled(enabled: Boolean) {
        minLevel = if (enabled) Level.DEBUG else Level.INFO
        i("AppLog", "log level -> ${minLevel.tag}")
    }

    fun isDebugEnabled(): Boolean = minLevel == Level.DEBUG

    // ── 对外接口（与 android.util.Log 同名，便于替换）──────────

    fun v(tag: String, msg: String) = write(Level.VERBOSE, tag, msg, null)
    fun d(tag: String, msg: String) = write(Level.DEBUG, tag, msg, null)
    fun i(tag: String, msg: String) = write(Level.INFO, tag, msg, null)
    fun w(tag: String, msg: String, tr: Throwable? = null) = write(Level.WARN, tag, msg, tr)
    fun e(tag: String, msg: String, tr: Throwable? = null) = write(Level.ERROR, tag, msg, tr)

    // ── 读取 / 导出 ───────────────────────────────────────────

    /** 所有分片，最新的在前。 */
    fun files(): List<File> {
        val dir = logDir ?: return emptyList()
        return dir.listFiles { f -> f.isFile && f.name.startsWith("linkok-") }
            ?.sortedByDescending { it.lastModified() }
            ?: emptyList()
    }

    /** 当前总占用字节数。 */
    fun totalBytes(): Long = files().sumOf { it.length() }

    /** 把日志拼成一份文本，供分享。最多取最近 [MAX_FILES] 个分片。 */
    fun exportText(): String {
        val sb = StringBuilder()
        sb.appendLine("LinkOK 日志导出")
        sb.appendLine("时间: ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())}")
        sb.appendLine("级别: ${minLevel.tag}")
        sb.appendLine("文件数: ${files().size}，共 ${totalBytes() / 1024} KB")
        sb.appendLine("----------------------------------------")
        // 旧文件在前，这样时间顺序是正序
        files().reversed().forEach { f ->
            sb.appendLine("### ${f.name} (${f.length()} bytes)")
            runCatching { sb.append(f.readText()) }
            sb.appendLine()
        }
        return sb.toString()
    }

    /** 立即把队列刷到磁盘（用于"立即导出"前保证完整）。 */
    fun flush() {
        // 提交一个空任务到同一线程池，前面的写任务都会先完成。
        runCatching { writer.submit { }.get() }
    }

    // ── 内部实现 ──────────────────────────────────────────────

    private fun write(level: Level, tag: String, msg: String, tr: Throwable?) {
        // 一律先转给 logcat：开发时用 adb 看最方便，且不依赖文件是否可写。
        when (level) {
            Level.VERBOSE -> Log.v(tag, msg, tr)
            Level.DEBUG -> Log.d(tag, msg, tr)
            Level.INFO -> Log.i(tag, msg, tr)
            Level.WARN -> Log.w(tag, msg, tr)
            Level.ERROR -> Log.e(tag, msg, tr)
        }

        if (level.weight < minLevel.weight) return
        if (!initialized) return

        val line = buildString {
            append(timeFormat.format(Date()))
            append(' ')
            append(level.tag)
            append(' ')
            append(tag)
            append(": ")
            append(msg)
            if (tr != null) {
                append(" | ")
                append(tr.javaClass.simpleName)
                append(": ")
                append(tr.message)
                tr.stackTrace.take(8).forEach {
                    append("\n    at ")
                    append(it.toString())
                }
            }
            append('\n')
        }

        synchronized(lock) {
            if (pending.size >= MAX_QUEUE) {
                // 有界队列：宁可丢日志也不能拖垮业务，但要记账。
                dropped.incrementAndGet()
                return
            }
            pending.addLast(line)
        }
        writer.execute { drain() }
    }

    private fun drain() {
        val batch = synchronized(lock) {
            if (pending.isEmpty()) return
            val items = ArrayList<String>(pending.size)
            items.addAll(pending)
            pending.clear()
            items
        }

        val dir = logDir ?: return
        rotateIfNeeded(force = false)

        val droppedNow = dropped.getAndSet(0)
        runCatching {
            val f = currentFile ?: return
            FileOutputStream(f, true).use { out ->
                OutputStreamWriter(out, Charsets.UTF_8).use { w ->
                    if (droppedNow > 0) {
                        w.write("${timeFormat.format(Date())} W AppLog: 队列溢出，已丢弃 $droppedNow 条日志\n")
                    }
                    batch.forEach { w.write(it) }
                    w.flush()
                }
            }
            currentBytes += batch.sumOf { it.toByteArray().size.toLong() }
        }.onFailure {
            // 写盘失败时不要再递归调用日志，否则会无限循环。
            Log.e("AppLog", "写日志失败: ${it.message}")
        }
    }

    /**
     * 检查是否需要切分片。
     *
     * 切分规则：按天分文件；同一天内超过 [MAX_FILE_BYTES] 就加序号后缀。
     * 分片总数超过 [MAX_FILES] 时删最旧的。
     */
    private fun rotateIfNeeded(force: Boolean) {
        val dir = logDir ?: return
        val today = fileFormat.format(Date())
        val file = currentFile

        val needRotate = force ||
            file == null ||
            currentDay != today ||
            !file.exists() ||
            currentBytes >= MAX_FILE_BYTES

        if (!needRotate) return

        currentDay = today
        // 找到一个还没满的同日文件名
        var index = 1
        var candidate: File
        while (true) {
            candidate = File(dir, "linkok-$today-${index.toString().padStart(2, '0')}.log")
            if (!candidate.exists() || candidate.length() < MAX_FILE_BYTES) break
            index++
        }
        currentFile = candidate
        currentBytes = candidate.length()
        pruneOldFiles(dir)
    }

    /** 只保留最近 MAX_FILES 个分片。 */
    private fun pruneOldFiles(dir: File) {
        val all = dir.listFiles { f -> f.isFile && f.name.startsWith("linkok-") } ?: return
        if (all.size <= MAX_FILES) return
        all.sortedBy { it.lastModified() }
            .take(all.size - MAX_FILES)
            .forEach { runCatching { it.delete() } }
    }
}
