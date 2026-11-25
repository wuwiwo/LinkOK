package com.linkok.app.net

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Link 的连接状态。术语见 CONTEXT.md。
 *
 * TOKEN_REJECTED 与 DISCONNECTED 要分开：前者是"配对已失效，重试无用"，
 * 后者是"暂时连不上，正在重试"。混为一谈会让用户以为是自己网络的问题。
 */
enum class LinkState { DISCONNECTED, CONNECTING, CONNECTED, TOKEN_REJECTED }

/**
 * Hub 下发的消息。
 */
sealed interface HubMessage {
    data object HelloOk : HubMessage
    data class IncomingCapture(
        val id: String,
        val sha256: String,
        val arrivedAt: String,
        val mime: String,
        val bytes: Long,
    ) : HubMessage
    data class ClipboardText(val text: String, val sha256: String) : HubMessage
    data class Pong(val at: Long) : HubMessage
}

/**
 * 手机与 Hub 之间的 WebSocket 客户端。
 *
 * 协议见 docs/PROTOCOL.md §5。要点：
 * - 单连接；重连指数退避 1s→30s。
 * - 二进制帧 >1MB 按 256KB 分片，带 seq/total。
 * - **Echo 抑制**是硬不变量：自己写入剪贴板的内容绝不能回传，否则两端互相覆盖成死循环。
 */
class HubClient(
    private val scope: CoroutineScope,
    private val deviceName: String,
    private val deviceModel: String,
) {
    companion object {
        private const val TAG = "HubClient"
        private const val CHUNK_THRESHOLD = 1024 * 1024      // 1MB
        private const val CHUNK_SIZE = 256 * 1024            // 256KB
        private const val PING_INTERVAL_MS = 20_000L
        private const val CONNECT_TIMEOUT_S = 10L
        private const val READ_TIMEOUT_S = 0L                // 长连接，靠 ping 保活
    }

    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_S, TimeUnit.SECONDS)
        .pingInterval(PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
        .build()

    private val _state = MutableStateFlow(LinkState.DISCONNECTED)
    val state: StateFlow<LinkState> = _state.asStateFlow()

    /** 收到的 Hub 消息。extraBufferCapacity 足够容纳一次连拍的若干条。 */
    private val _messages = MutableSharedFlow<HubMessage>(
        replay = 0,
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val messages: SharedFlow<HubMessage> = _messages.asSharedFlow()

    /** 分片重组缓冲：id -> (已收字节, 期望帧数)。 */
    private val chunks = mutableMapOf<String, Pair<ByteArrayOutputStream, Int>>()
    private var pendingCaptureId: String? = null
    private var pendingCaptureMeta: HubMessage.IncomingCapture? = null

    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var pingJob: Job? = null
    private var attempt = 0

    private var host: String = ""
    private var port: Int = 0
    private var token: String = ""

    /** 最近一次自己写入剪贴板的文本哈希，用于 Echo 抑制。 */
    @Volatile
    private var lastSelfWrittenHash: String? = null

    fun connect(host: String, port: Int, token: String) {
        if (socket != null && this.host == host && this.port == port) return
        this.host = host
        this.port = port
        this.token = token
        attempt = 0
        open()
    }

    fun disconnect() {
        reconnectJob?.cancel(); reconnectJob = null
        pingJob?.cancel(); pingJob = null
        socket?.close(1000, "client disconnect")
        socket = null
        _state.value = LinkState.DISCONNECTED
    }

    /** 由剪贴板写入方调用：登记「这是我写的」，后续收到同哈希时必须丢弃。 */
    fun noteSelfWritten(text: String) {
        lastSelfWrittenHash = sha256(text)
    }

    /**
     * 判断一条来自 Hub 的剪贴板文本是否应当被忽略。
     * 返回 true 表示这是回声，必须丢弃。
     */
    fun isEcho(text: String, claimedSha: String?): Boolean {
        val actual = sha256(text)
        // 双重判断：既比 Hub 声称的 hash，也比我们自己记录的 hash。
        // Hub 的 hash 不可信（可能被篡改或实现有误），自定义的才是权威。
        if (!claimedSha.isNullOrBlank() && claimedSha != actual) {
            Log.w(TAG, "clipboard hash 与内容不符，按内容哈希处理")
        }
        return actual == lastSelfWrittenHash
    }

    // ── 发送 ──────────────────────────────────────────────

    fun sendClipboard(text: String) {
        val ws = socket ?: return
        val truncated = if (text.length > 64 * 1024) text.substring(0, 64 * 1024) else text
        noteSelfWritten(truncated)
        val payload = buildJsonObject {
            put("type", "clipboard")
            put("text", truncated)
            put("sha256", sha256(truncated))
        }
        ws.send(payload.toString())
    }

    /**
     * 上行一张 Capture。协议见 PROTOCOL.md §5.2。
     * 大图分片，每片前导一条 chunk 控制帧。
     */
    fun sendCapture(id: String, sha256: String, arrivedAt: String, png: ByteArray) {
        val ws = socket ?: return
        val meta = buildJsonObject {
            put("type", "capture")
            put("id", id)
            put("sha256", sha256)
            put("arrivedAt", arrivedAt)
            put("mime", "image/png")
            put("bytes", png.size)
        }
        ws.send(meta.toString())

        if (png.size <= CHUNK_THRESHOLD) {
            ws.send(png.toByteString())
        } else {
            val total = (png.size + CHUNK_SIZE - 1) / CHUNK_SIZE
            for (seq in 0 until total) {
                val from = seq * CHUNK_SIZE
                val to = minOf(from + CHUNK_SIZE, png.size)
                val head = buildJsonObject {
                    put("type", "chunk")
                    put("id", id)
                    put("seq", seq)
                    put("total", total)
                }
                ws.send(head.toString())
                ws.send(png.copyOfRange(from, to).toByteString())
            }
        }
    }

    // ── 内部 ──────────────────────────────────────────────

    private fun open() {
        if (host.isBlank() || port <= 0 || token.isBlank()) {
            Log.w(TAG, "缺少连接参数，跳过连接")
            return
        }
        _state.value = LinkState.CONNECTING
        val url = "ws://$host:$port/ws"
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .build()

        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "已连接 $url")
                attempt = 0
                _state.value = LinkState.CONNECTED
                webSocket.send(buildJsonObject {
                    put("type", "hello")
                    put("deviceName", deviceName)
                    put("deviceModel", deviceModel)
                    put("protocolVersion", 1)
                }.toString())
                startPing()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleText(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handleBinary(bytes)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                Log.w(TAG, "连接失败: ${t.message} (code=$code)")

                if (code == 401) {
                    // Token 已失效：电脑端重新配对过、数据目录被删、或换了机器。
                    // 这时无限重试毫无意义 —— 每次都会 401，用户看到的是永远"未连接"，
                    // 而"重新配对"似乎也没反应（因为旧的失败循环还在打断它）。
                    // 唯一正确的做法：停止重连，把状态明确标为"配对失效"。
                    Log.w(TAG, "Token 被拒绝（401），停止重连并要求重新配对")
                    _state.value = LinkState.TOKEN_REJECTED
                    chunkCleanup()
                    reconnectJob?.cancel(); reconnectJob = null
                    pingJob?.cancel(); pingJob = null
                    socket = null
                    // 清空内存里的连接参数，避免后续误用。
                    host = ""
                    token = ""
                    return
                }

                _state.value = LinkState.DISCONNECTED
                chunkCleanup()
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "连接关闭 code=$code reason=$reason")
                _state.value = LinkState.DISCONNECTED
                chunkCleanup()
                if (code != 1000) scheduleReconnect()
            }
        })
    }

    private fun handleText(text: String) {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (obj["type"]?.jsonPrimitive?.content) {
            "hello-ok" -> _messages.tryEmit(HubMessage.HelloOk)

            "capture" -> {
                val meta = HubMessage.IncomingCapture(
                    id = obj.str("id"),
                    sha256 = obj.str("sha256"),
                    arrivedAt = obj.str("arrivedAt"),
                    mime = obj.str("mime"),
                    bytes = obj["bytes"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                )
                pendingCaptureMeta = meta
                pendingCaptureId = meta.id
                chunks[meta.id] = ByteArrayOutputStream() to 1
            }

            "chunk" -> {
                val id = obj.str("id")
                val total = obj["total"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1
                chunks.getOrPut(id) { ByteArrayOutputStream() to total }
                chunks[id] = chunks.getValue(id).first to total
            }

            "clipboard" -> {
                _messages.tryEmit(
                    HubMessage.ClipboardText(obj.str("text"), obj.str("sha256"))
                )
            }

            "pong" -> _messages.tryEmit(HubMessage.Pong(System.currentTimeMillis()))

            "capture-result" -> {
                val ok = obj["ok"]?.jsonPrimitive?.content
                Log.d(TAG, "capture-result id=${obj.str("id")} ok=$ok")
            }

            else -> Log.d(TAG, "未处理的消息类型: ${obj["type"]}")
        }
    }

    private fun handleBinary(bytes: ByteString) {
        val id = pendingCaptureId ?: run {
            Log.w(TAG, "收到二进制帧但没有待接收的 capture")
            return
        }
        val entry = chunks[id] ?: run {
            Log.w(TAG, "分片缓冲缺失 id=$id")
            return
        }
        entry.first.write(bytes.toByteArray())

        val meta = pendingCaptureMeta
        val expected = meta?.bytes ?: -1L
        // 已知总大小时按大小判断完整；未知时先按「不再有后续 chunk」处理。
        if (expected >= 0 && entry.first.size().toLong() >= expected) {
            finishCapture(id, entry.first.toByteArray())
        }
    }

    private fun finishCapture(id: String, data: ByteArray) {
        val meta = pendingCaptureMeta
        chunks.remove(id)
        pendingCaptureId = null
        pendingCaptureMeta = null

        if (meta == null) {
            sendCaptureResult(id, ok = false, reason = "no_meta")
            return
        }
        val actual = sha256Bytes(data)
        if (meta.sha256.isNotBlank() && actual != meta.sha256) {
            Log.e(TAG, "图片哈希不符，丢弃 id=$id 期望=${meta.sha256} 实际=$actual")
            sendCaptureResult(id, ok = false, reason = "hash_mismatch")
            return
        }

        _messages.tryEmit(meta)
        // 图像本体通过 completedCapture 交给 Service，避免大字节数组进出 Flow。
        val handled = completedCaptureHandler?.invoke(meta, data) ?: false
        // 关键：必须回 ACK。
        // PROTOCOL §5.3 规定接收端用 capture-result 确认；Hub 的 PC Capture 是
        // **严格串行**投递的 —— 它等这条 ACK 或 10 秒超时才发下一张。
        // 早先这里只把图交给上层就结束了，于是 Hub 每次都等满 10 秒，
        // 用户看到的是"电脑截图，手机没收到"，日志是
        // `no capture-result ... after 10s; moving on`。
        sendCaptureResult(id, ok = handled, reason = if (handled) null else "store_failed")
    }

    /** 回执。收到 PC Capture 后必须调用，否则 Hub 的串行队列会卡住。 */
    private fun sendCaptureResult(id: String, ok: Boolean, reason: String?) {
        val payload = buildJsonObject {
            put("type", "capture-result")
            put("id", id)
            put("ok", ok)
            if (reason != null) put("reason", reason)
        }
        socket?.send(payload.toString())
        Log.d(TAG, "capture-result id=$id ok=$ok${reason?.let { " reason=$it" } ?: ""}")
    }

    /**
     * Service 注册：收到完整图片后立即回调，避免大字节数组进出 Flow。
     * 返回 true 表示已成功落盘；false 会让客户端回 `ok:false`，
     * 让 Hub 知道这次投递失败（而不是默默等超时）。
     */
    var completedCaptureHandler: ((HubMessage.IncomingCapture, ByteArray) -> Boolean)? = null

    private fun startPing() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive) {
                delay(PING_INTERVAL_MS)
                socket?.send("""{"type":"ping"}""")
            }
        }
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        reconnectJob = scope.launch {
            val wait = backoffMs(attempt)
            Log.i(TAG, "第 ${attempt + 1} 次重连，等待 ${wait}ms")
            delay(wait)
            attempt++
            open()
        }
    }

    /** 1s → 2s → 4s → 8s → 16s → 30s（上限）。见 PROTOCOL.md §5.5。 */
    private fun backoffMs(n: Int): Long {
        val base = 1000L shl n.coerceAtMost(5)
        return base.coerceAtMost(30_000L)
    }

    private fun chunkCleanup() {
        chunks.clear()
        pendingCaptureId = null
        pendingCaptureMeta = null
    }

    private fun JsonObject.str(key: String): String =
        this[key]?.jsonPrimitive?.content ?: ""

    private fun sha256(s: String): String = sha256Bytes(s.toByteArray(Charsets.UTF_8))

    private fun sha256Bytes(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { "%02x".format(it) }
    }
}
