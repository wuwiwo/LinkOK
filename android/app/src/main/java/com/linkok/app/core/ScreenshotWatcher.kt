package com.linkok.app.core

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import android.content.ContentUris
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/**
 * 手机截图监听。
 *
 * 用 ContentObserver 监听 MediaStore 中截图目录的新增项。
 * 这是「手机截图 → 电脑立即知道」唯一合规的实现方式（见 ADR 0001）。
 *
 * 去重（PROTOCOL.md §9）：按**内容 SHA-256**，不是文件名 —— 同一张图被重复
 * 写入或改名后重新落盘时，文件名会变而内容不变。
 */
class ScreenshotWatcher(
    private val context: Context,
    private val scope: CoroutineScope,
) {
    companion object {
        private const val TAG = "ScreenshotWatcher"

        /** 小米的截图目录。RELATIVE_PATH 在 Android 10+ 可用。 */
        private val SCREENSHOT_DIRS = listOf(
            "DCIM/Screenshots",
            "Pictures/Screenshots",
            "Pictures/截图",
            "DCIM/截图",
        )
    }

    /** 已经投递过的哈希，防止重复。上限滚动保留，避免内存无限增长。 */
    private val seen = object : LinkedHashSet<String>() {
        override fun add(element: String): Boolean {
            val added = super.add(element)
            if (size > 512) remove(first())
            return added
        }
    }

    private val pending = Channel<Uri>(Channel.UNLIMITED)
    private var observer: ContentObserver? = null
    private val job = SupervisorJob()

    /** 收到一张新截图时回调：(png 字节, 宽, 高)。 */
    var onCapture: ((ByteArray, Int, Int) -> Unit)? = null

    fun start() {
        if (observer != null) return

        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri != null) pending.trySend(uri)
            }
        }
        context.contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            obs,
        )
        observer = obs

        // 处理队列：串行，保证同一时刻只处理一张。
        scope.launch(Dispatchers.IO + job) {
            for (uri in pending) {
                runCatching { handle(uri) }
                    .onFailure { Log.w(TAG, "处理截图失败 uri=$uri", it) }
            }
        }
        Log.i(TAG, "截图监听已启动")
    }

    fun stop() {
        observer?.let { context.contentResolver.unregisterContentObserver(it) }
        observer = null
        job.cancel()
        Log.i(TAG, "截图监听已停止")
    }

    private suspend fun handle(uri: Uri) = withContext(Dispatchers.IO) {
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.RELATIVE_PATH,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.DATE_ADDED,
        )
        context.contentResolver.query(uri, projection, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return@withContext
            val relative = c.getColumnIndex(MediaStore.Images.Media.RELATIVE_PATH)
                .takeIf { it >= 0 }?.let { c.getString(it) } ?: ""
            val name = c.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME)
                .takeIf { it >= 0 }?.let { c.getString(it) } ?: ""

            // 只关心截图目录，不处理相册里其他图片。
            val isScreenshot = SCREENSHOT_DIRS.any { rel ->
                relative.trimEnd('/').equals(rel, ignoreCase = true)
            } || name.startsWith("Screenshot", ignoreCase = true) ||
                name.startsWith("截图", ignoreCase = true)

            if (!isScreenshot) return@withContext

            val width = c.getColumnIndex(MediaStore.Images.Media.WIDTH)
                .takeIf { it >= 0 }?.let { c.getInt(it) } ?: 0
            val height = c.getColumnIndex(MediaStore.Images.Media.HEIGHT)
                .takeIf { it >= 0 }?.let { c.getInt(it) } ?: 0

            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                ?: return@withContext

            if (bytes.isEmpty()) return@withContext
            if (bytes.size > 20 * 1024 * 1024) {
                Log.w(TAG, "截图超过 20MB，跳过: ${bytes.size} bytes")
                return@withContext
            }

            // 关键：手机截图是 JPG（小米默认，也可能是 HEIF/WEBP），不是 PNG。
            // 协议（PROTOCOL §9）要求统一 PNG，Hub 会拒绝非 PNG 载荷，
            // 所以这里必须真正转码，而不是把原始字节贴个 "image/png" 的标签发出去。
            val png = if (isPng(bytes)) {
                bytes
            } else {
                transcodeToPng(bytes) ?: run {
                    Log.w(TAG, "无法转码为 PNG，跳过: $name")
                    return@withContext
                }
            }

            // 哈希用**转码后**的内容：Hub 校验的是实际收到的字节。
            val hash = sha256(png)
            if (!seen.add(hash)) {
                Log.d(TAG, "重复截图，跳过: $name")
                return@withContext
            }

            val finalWidth: Int
            val finalHeight: Int
            if (isPng(bytes)) {
                finalWidth = width; finalHeight = height
            } else {
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(png, 0, png.size, opts)
                finalWidth = opts.outWidth.takeIf { it > 0 } ?: width
                finalHeight = opts.outHeight.takeIf { it > 0 } ?: height
            }

            Log.i(TAG, "捕获截图: $name (${bytes.size} -> ${png.size} bytes, ${finalWidth}x$finalHeight)")
            onCapture?.invoke(png, finalWidth, finalHeight)
        }
    }

    private fun isPng(bytes: ByteArray): Boolean {
        if (bytes.size < 8) return false
        val magic = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        return magic.indices.all { bytes[it] == magic[it] }
    }

    /**
     * 解码任意格式再编码成 PNG。
     * 用无损 PNG 是为了保真（压缩后再转 JPG 会有代际损失），
     * 代价是体积变大；20MB 上限在 1080×2400 的截图上仍然安全。
     */
    private fun transcodeToPng(src: ByteArray): ByteArray? = runCatching {
        val bitmap = BitmapFactory.decodeByteArray(src, 0, src.size) ?: return null
        try {
            ByteArrayOutputStream(src.size.coerceAtLeast(64 * 1024)).use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                out.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }.getOrElse {
        Log.w(TAG, "转码失败", it)
        null
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

