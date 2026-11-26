package com.linkok.app.core

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File

/**
 * 把图片写进系统相册 Pictures/LinkOK。
 *
 * 术语见 CONTEXT.md：Save 是把 Capture 从 Stash **搬进**系统相册，
 * 之后这份文件不再受 Retention 约束 —— 它是用户自己的了。
 */
object GallerySaver {
    private const val TAG = "GallerySaver"
    private const val ALBUM = "LinkOK"

    /**
     * @param src 要保存的 PNG 文件
     * @param baseName 不含扩展名的文件名
     * @return true 表示已成功写入相册
     */
    fun savePng(context: Context, src: File, baseName: String): Boolean {
        if (!src.exists() || src.length() == 0L) {
            AppLog.w(TAG, "源文件不存在或为空: ${src.absolutePath}")
            return false
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(context, src, baseName)
        } else {
            saveViaFile(context, src, baseName)
        }
    }

    /** Android 10+：走 MediaStore，无需存储权限。 */
    private fun saveViaMediaStore(context: Context, src: File, baseName: String): Boolean {
        val resolver = context.contentResolver
        val relative = "${Environment.DIRECTORY_PICTURES}/$ALBUM"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "$baseName.png")
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(MediaStore.Images.Media.RELATIVE_PATH, relative)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }

        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: run {
                AppLog.e(TAG, "插入 MediaStore 失败")
                return false
            }

        return try {
            resolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { it.copyTo(out) }
            } ?: throw IllegalStateException("无法打开输出流")

            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            AppLog.i(TAG, "已保存到相册: $relative/$baseName.png")
            true
        } catch (e: Exception) {
            AppLog.e(TAG, "写入相册失败", e)
            // 清理半成品，避免相册里出现损坏条目。
            runCatching { resolver.delete(uri, null, null) }
            false
        }
    }

    /** Android 9 及以下的兜底路径。minSdk 29 起实际走不到，保留以防降级。 */
    private fun saveViaFile(context: Context, src: File, baseName: String): Boolean {
        val dir = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
            ALBUM,
        )
        if (!dir.exists() && !dir.mkdirs()) {
            AppLog.e(TAG, "无法创建目录 ${dir.absolutePath}")
            return false
        }
        return runCatching {
            val dest = File(dir, "$baseName.png")
            src.copyTo(dest, overwrite = true)
            AppLog.i(TAG, "已保存到 ${dest.absolutePath}")
            true
        }.getOrElse {
            AppLog.e(TAG, "复制失败", it)
            false
        }
    }
}
