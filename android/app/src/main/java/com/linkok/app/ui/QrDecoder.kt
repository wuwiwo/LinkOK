package com.linkok.app.ui

import com.linkok.app.core.AppLog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.YuvImage
import android.net.Uri
import android.util.Log
import androidx.camera.core.ImageProxy
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.io.ByteArrayOutputStream

/**
 * 二维码解码。
 *
 * 两处来源：
 * 1. **相机帧**（[decodeFromImageProxy]）—— CameraX 给的 YUV_420_888。
 *    直接在 Y plane 上解码，不做 RGB 转换，省一次全图拷贝。
 * 2. **相册图片**（[decodeFromUri]）—— 走 Bitmap + RGB 解码。
 *
 * 用 zxing 的 core（Reader），不用 zxing-android-embedded 的 Intent 封装 ——
 * 那个只能弹全屏 Activity，做不成页内取景框。
 */
object QrDecoder {

    private const val TAG = "QrDecoder"

    private val reader: MultiFormatReader by lazy {
        MultiFormatReader().apply {
            setHints(
                mapOf(
                    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                    // 二维码是配对链接，不是长文本，TRY_HARDER 意义不大，
                    // 但开了能提高反光/倾斜时的成功率，代价可以接受。
                    DecodeHintType.TRY_HARDER to true,
                )
            )
        }
    }

    /** 从相机帧解码。返回 null 表示这一帧没有可识别的码。 */
    fun decodeFromImageProxy(image: ImageProxy): String? {
        return try {
            when (image.format) {
                ImageFormat.YUV_420_888 -> decodeYuv(image)
                ImageFormat.JPEG -> {
                    val bytes = image.planes[0].buffer.let { buf ->
                        ByteArray(buf.remaining()).also { buf.get(it) }
                    }
                    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
                    decodeBitmap(bmp)
                }
                else -> {
                    AppLog.d(TAG, "不支持的帧格式: ${image.format}")
                    null
                }
            }
        } catch (e: Exception) {
            AppLog.w(TAG, "解码帧失败", e)
            null
        }
    }

    /**
     * 只取 Y 平面（亮度）做解码。
     *
     * 二维码是黑白的，色度信息没有用。直接喂 Y plane 既快又稳，
     * 还避免了 YUV→RGB 的转换在低端机上拖慢预览。
     */
    private fun decodeYuv(image: ImageProxy): String? {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)

        val width = image.width
        val height = image.height
        // rowStride 可能大于 width（有 padding），需要按 stride 描述源。
        val rowStride = plane.rowStride
        val source = PlanarYUVLuminanceSource(
            data,
            rowStride,
            height,
            0,
            0,
            width,
            height,
            false,
        )
        return decodeSource(source)
    }

    /** 从相册 Uri 解码。 */
    fun decodeFromUri(context: Context, uri: Uri): String? {
        return try {
            val input = context.contentResolver.openInputStream(uri) ?: return null
            // 大图先按 1600px 缩放，既省内存也够二维码识别。
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            input.use { BitmapFactory.decodeStream(it, null, opts) }
            if (opts.outWidth <= 0 || opts.outHeight <= 0) return null

            val sample = calcInSampleSize(opts.outWidth, opts.outHeight, 1600)
            val readOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bmp = context.contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, readOpts)
            } ?: return null

            decodeBitmap(bmp) ?: decodeRotated(bmp)
        } catch (e: Exception) {
            AppLog.w(TAG, "解码图片失败", e)
            null
        }
    }

    /** 有些截图是横着存的，转 90/180/270 再试一遍。 */
    private fun decodeRotated(src: Bitmap): String? {
        for (degrees in intArrayOf(90, 180, 270)) {
            val m = Matrix().apply { postRotate(degrees.toFloat()) }
            val rotated = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
            val text = decodeBitmap(rotated)
            if (rotated !== src) rotated.recycle()
            if (text != null) return text
        }
        return null
    }

    private fun decodeBitmap(bmp: Bitmap): String? {
        val width = bmp.width
        val height = bmp.height
        val pixels = IntArray(width * height)
        bmp.getPixels(pixels, 0, width, 0, 0, width, height)
        val source = RGBLuminanceSource(width, height, pixels)
        return decodeSource(source)
    }

    private fun decodeSource(source: LuminanceSource?): String? {
        if (source == null) return null
        return decodeBinary(BinaryBitmap(HybridBinarizer(source)))
    }

    private fun decodeBinary(bitmap: BinaryBitmap): String? {
        return try {
            // 每次都 reset：MultiFormatReader 是有状态的，上一帧的 hints 会残留。
            reader.reset()
            reader.decodeWithState(bitmap).text
        } catch (e: Exception) {
            // NotFoundException 是常态（大部分帧里没有码），不打日志免得刷屏。
            null
        } finally {
            reader.reset()
        }
    }

    private fun calcInSampleSize(w: Int, h: Int, target: Int): Int {
        var sample = 1
        var width = w
        var height = h
        while (width / 2 >= target && height / 2 >= target) {
            width /= 2
            height /= 2
            sample *= 2
        }
        return sample
    }
}
