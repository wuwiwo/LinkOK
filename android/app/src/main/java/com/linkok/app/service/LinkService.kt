package com.linkok.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.linkok.app.MainActivity
import com.linkok.app.core.ConfigStore
import com.linkok.app.core.GallerySaver
import com.linkok.app.core.ScreenshotWatcher
import com.linkok.app.core.StashStore
import com.linkok.app.net.HubClient
import com.linkok.app.net.HubMessage
import com.linkok.app.net.LinkState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import java.time.Instant

/**
 * LinkOK 的常驻前台服务。
 *
 * 职责：
 * - 维持与 Hub 的 Link（WebSocket）
 * - 监听手机截图并上行
 * - 接收 PC Capture 落入 Stash
 * - 双向剪贴板同步（含 Echo 抑制）
 * - 每小时执行一次 Retention
 *
 * 为什么必须前台服务：Android 会随时回收后台进程，而「手机截图电脑立即知道」
 * 要求进程活着。见 SPEC §5.1 与 ADR 0001。
 */
class LinkService : Service() {

    companion object {
        private const val TAG = "LinkService"
        private const val CHANNEL_ID = "linkok_service"
        private const val NOTIFICATION_ID = 1001
        private const val RETENTION_INTERVAL_MS = 60L * 60 * 1000

        const val ACTION_START = "com.linkok.app.START"
        const val ACTION_STOP = "com.linkok.app.STOP"

        /** 供 UI 观察当前状态。Service 活着时才有值。 */
        @Volatile
        var instance: LinkService? = null
            private set
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var configStore: ConfigStore
    private lateinit var stash: StashStore
    private lateinit var watcher: ScreenshotWatcher
    private lateinit var hub: HubClient

    private var retentionJob: Job? = null
    private var pendingCount = 0

    val linkState: LinkState get() = hub.state.value

    override fun onCreate() {
        super.onCreate()
        instance = this
        configStore = ConfigStore(this)
        stash = StashStore(this)
        hub = HubClient(scope, deviceName(), deviceModel())

        createChannel()
        startForegroundCompat(buildNotification("正在启动"))

        watcher = ScreenshotWatcher(this, scope).apply {
            onCapture = { bytes, w, h -> onPhoneCapture(bytes, w, h) }
        }
        hub.completedCaptureHandler = { meta, data -> onPcCapture(meta, data) }

        scope.launch { observeLinkState() }
        scope.launch { observeMessages() }
        scope.launch { connectWithSavedConfig() }
        startRetentionLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        instance = null
        runCatching { watcher.stop() }
        runCatching { hub.disconnect() }
        scope.cancel()
        super.onDestroy()
    }

    // ── 连接 ──────────────────────────────────────────────

    private suspend fun connectWithSavedConfig() {
        val cfg = configStore.current()
        if (cfg.token.isBlank() || cfg.hubAddress.isBlank()) {
            Log.w(TAG, "尚未配对，服务保持运行但不连接")
            updateNotification("尚未配对")
            return
        }
        val (host, port) = splitAddress(cfg.hubAddress) ?: run {
            Log.e(TAG, "地址格式非法: ${cfg.hubAddress}")
            updateNotification("地址无效，请重新配对")
            return
        }
        hub.connect(host, port, cfg.token)
        watcher.start()
    }

    /** 供配对成功后立即重连。 */
    fun reconnectWith(config: com.linkok.app.core.PhoneConfig) {
        val (host, port) = splitAddress(config.hubAddress) ?: return
        hub.disconnect()
        hub.connect(host, port, config.token)
        watcher.start()
    }

    private fun splitAddress(address: String): Pair<String, Int>? {
        val idx = address.lastIndexOf(':')
        if (idx <= 0) return null
        val host = address.substring(0, idx)
        val port = address.substring(idx + 1).toIntOrNull() ?: return null
        return host to port
    }

    private fun observeLinkState() {
        scope.launch {
            hub.state.collect { st ->
                val text = when (st) {
                    LinkState.CONNECTED -> "已连接"
                    LinkState.CONNECTING -> "正在连接"
                    LinkState.DISCONNECTED -> "电脑未连接"
                    LinkState.TOKEN_REJECTED -> "配对已失效，请重新配对"
                }
                updateNotification(text)
            }
        }
    }

    private fun observeMessages() {
        scope.launch {
            hub.messages.collect { msg ->
                when (msg) {
                    is HubMessage.ClipboardText -> applyRemoteClipboard(msg)
                    else -> Unit
                }
            }
        }
    }

    // ── Capture 处理 ───────────────────────────────────────

    /** 手机截图 → 上行到 PC。 */
    private fun onPhoneCapture(bytes: ByteArray, width: Int, height: Int) {
        scope.launch {
            if (hub.state.value != LinkState.CONNECTED) {
                Log.w(TAG, "Link 未就绪，截图暂不上行")
                return@launch
            }
            val hash = sha256Hex(bytes)
            val arrivedAt = Instant.now().toString()
            val id = arrivedAt.replace("-", "").replace(":", "").replace(".", "").take(18) +
                "-" + hash.take(6)
            hub.sendCapture(id, hash, arrivedAt, bytes)
            Log.i(TAG, "已上行截图 $id (${bytes.size} bytes, ${width}x$height)")
        }
    }

    /**
     * PC Capture → 落入 Stash。静默，不发通知（SPEC §5.2）。
     *
     * 返回 true/false 会被 HubClient 转成 `capture-result` 的 ok 字段。
     * Hub 严格串行投递，等不到回执就卡 10 秒，所以这里必须如实反映落盘结果。
     */
    private fun onPcCapture(meta: HubMessage.IncomingCapture, data: ByteArray): Boolean {
        // 同步落盘：调用方需要立刻知道成败才能回 ACK。
        // 用 runBlocking 是刻意的 —— 这段代码跑在 HubClient 的读线程上，
        // 一次磁盘写入只有几毫秒，换取确定的 ACK 语义值得。
        return try {
            val item = kotlinx.coroutines.runBlocking { stash.put(data, 0, 0) }
            if (item == null) {
                Log.d(TAG, "重复的 PC Capture，已丢弃 ${meta.id}")
                // 重复不是失败：Hub 应当继续投递下一张。
                true
            } else {
                pendingCount = kotlinx.coroutines.runBlocking { stash.list().size }
                updateNotification(if (pendingCount > 0) "已连接 · 待保存 $pendingCount 张" else "已连接")
                Log.i(TAG, "PC Capture 已入 Stash: ${item.id}")
                // UI 正在看这个列表时要立刻看到新图。
                refreshSignal()
                true
            }
        } catch (e: Exception) {
            Log.e(TAG, "PC Capture 落盘失败 ${meta.id}", e)
            false
        }
    }

    /** 通知 UI 刷新 Stash。 */
    private fun refreshSignal() {
        // LinkViewModel 每秒轮询一次状态，并在连上时重读列表，
        // 所以这里不需要额外通道；保留此方法作为将来接 Flow 的挂点。
    }

    // ── 剪贴板 ────────────────────────────────────────────

    private fun applyRemoteClipboard(msg: HubMessage.ClipboardText) {
        // Echo 抑制：这是硬不变量。见 PROTOCOL.md §5.6。
        if (hub.isEcho(msg.text, msg.sha256)) {
            Log.d(TAG, "忽略回声剪贴板内容")
            return
        }
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText("LinkOK", msg.text)
        runCatching {
            cm.setPrimaryClip(clip)
            hub.noteSelfWritten(msg.text)
            // 让首页看得到"刚刚同步过来什么"。
            clipboardObserver?.invoke("inbound", msg.text)
        }.onFailure { Log.w(TAG, "写入剪贴板失败", it) }
    }

    /**
     * 剪贴板活动回调，由 UI 层注册，用于在首页展示最近一次收/发。
     * 用回调而不是 EventBus/Flow，因为只有一个订阅者，且它随时可能不存在。
     */
    var clipboardObserver: ((direction: String, text: String) -> Unit)? = null

    /** 由无障碍服务或磁贴调用：把本机剪贴板内容推到 PC。 */
    fun pushClipboardToHub(text: String) {
        if (text.isBlank()) return
        hub.sendClipboard(text)
        clipboardObserver?.invoke("outbound", text)
    }

    // ── Retention ─────────────────────────────────────────

    private fun startRetentionLoop() {
        retentionJob?.cancel()
        retentionJob = scope.launch {
            while (true) {
                runCatching {
                    val cfg = configStore.current()
                    val removed = stash.sweepRetention(cfg.retentionDays)
                    if (removed > 0) Log.i(TAG, "Retention 清理了 $removed 张")
                    pendingCount = stash.list().size
                }.onFailure { Log.w(TAG, "Retention 执行失败", it) }
                delay(RETENTION_INTERVAL_MS)
            }
        }
    }

    // ── 通知 ──────────────────────────────────────────────

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(
            CHANNEL_ID,
            "LinkOK 运行状态",
            NotificationManager.IMPORTANCE_LOW,   // 静默，不打扰
        ).apply {
            description = "显示连接状态与待保存的截图数量"
            setShowBadge(false)
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("LinkOK")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}"

    private fun deviceModel(): String = Build.MODEL

    private fun sha256Hex(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
