package com.linkok.app.net

import com.linkok.app.core.AppLog
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

/**
 * 配对：扫码后用一次性配对码换长期 Token。
 * 协议见 docs/PROTOCOL.md §6.1。
 */
object Pairing {

    private const val TAG = "Pairing"

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    /** 从二维码解出的配对信息。 */
    data class Payload(
        val host: String,
        val port: Int,
        val code: String,
        val fingerprint: String,
    ) {
        val address: String get() = "$host:$port"
    }

    data class Result(
        val token: String,
        val address: String,
        val fingerprint: String,
    )

    /**
     * 解析 `linkok://pair?host=…&port=…&code=…&fp=…`
     * 返回 null 表示不是合法载荷。
     */
    fun parseQr(raw: String): Payload? {
        val trimmed = raw.trim()
        if (!trimmed.startsWith("linkok://pair", ignoreCase = true)) return null
        val qIndex = trimmed.indexOf('?')
        if (qIndex < 0) return null
        val query = trimmed.substring(qIndex + 1)

        val params = query.split('&').mapNotNull { pair ->
            val eq = pair.indexOf('=')
            if (eq <= 0) return@mapNotNull null
            val k = pair.substring(0, eq)
            val v = runCatching { URLDecoder.decode(pair.substring(eq + 1), "UTF-8") }
                .getOrDefault(pair.substring(eq + 1))
            k to v
        }.toMap()

        val host = params["host"]?.takeIf { it.isNotBlank() } ?: return null
        val port = params["port"]?.toIntOrNull() ?: return null
        val code = params["code"]?.takeIf { it.isNotBlank() } ?: return null
        val fp = params["fp"] ?: ""

        return Payload(host, port, code, fp)
    }

    /**
     * 用配对码换 Token。
     * @return Result 成功；null 失败（原因见日志）
     */
    suspend fun pair(
        payload: Payload,
        deviceName: String,
        deviceModel: String,
    ): Result? = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("code", payload.code)
            put("deviceName", deviceName)
            put("deviceModel", deviceModel)
        }.toString()

        val req = Request.Builder()
            .url("http://${payload.host}:${payload.port}/pair")
            .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()

        // 记录"开始尝试"，与下面的成功/失败日志配对 —— 排查时能看到
        // 到底发出了几次请求（扫码页曾经每帧触发一次，日志是定位依据）。
        AppLog.i(TAG, "开始配对 → ${payload.host}:${payload.port} code=${payload.code}")

        runCatching {
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    AppLog.w(TAG, "配对失败 HTTP ${resp.code}: $text")
                    return@withContext null
                }
                val obj = json.parseToJsonElement(text).jsonObject
                val token = obj["token"]?.jsonPrimitive?.content
                if (token.isNullOrBlank()) {
                    AppLog.w(TAG, "配对响应缺少 token: $text")
                    return@withContext null
                }
                AppLog.i(TAG, "配对成功，token 长度 ${token.length}")
                Result(token, payload.address, payload.fingerprint)
            }
        }.getOrElse {
            AppLog.w(TAG, "配对请求异常", it)
            null
        }
    }

    /** 探测某个地址是否是可用的 Hub（用于 UDP 重发现后验证）。 */
    suspend fun probe(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("http://$host:$port/health")
            .get()
            .build()
        runCatching {
            client.newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }
}
