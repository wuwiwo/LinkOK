package com.linkok.app.ui

import android.util.Log
import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.linkok.app.core.ConfigStore
import com.linkok.app.core.GallerySaver
import com.linkok.app.core.PhoneConfig
import com.linkok.app.core.StashItem
import com.linkok.app.core.StashStore
import com.linkok.app.net.LinkState
import com.linkok.app.net.Pairing
import com.linkok.app.service.LinkService
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * 首页展示用的一条剪贴板同步记录。
 * @param direction "inbound" = 电脑→手机，"outbound" = 手机→电脑
 */
data class ClipboardEcho(
    val direction: String,
    val preview: String,
    val chars: Int,
    val at: Instant,
)

/**
 * 手机端唯一的 ViewModel，持有 Stash 与连接状态。
 * UI 只读这里的状态，所有副作用都经由它。
 */
class LinkViewModel(app: Application) : AndroidViewModel(app) {

    companion object { private const val TAG = "LinkViewModel" }

    private val context: Context get() = getApplication()

    private val stashStore = StashStore(context)
    private val configStore = ConfigStore(context)

    private val _items = MutableStateFlow<List<StashItem>>(emptyList())
    val items: StateFlow<List<StashItem>> = _items.asStateFlow()

    private val _config = MutableStateFlow(PhoneConfig())
    val config: StateFlow<PhoneConfig> = _config.asStateFlow()

    private val _linkState = MutableStateFlow(LinkState.DISCONNECTED)
    val linkState: StateFlow<LinkState> = _linkState.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    /** 一次性提示消息，UI 消费后应调用 clearMessage()。 */
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    private val _selection = MutableStateFlow<Set<String>>(emptySet())
    val selection: StateFlow<Set<String>> = _selection.asStateFlow()

    /**
     * 最近同步的剪贴板文本。
     *
     * 为什么要有：剪贴板同步原本完全透明 —— 内容写进系统剪贴板就没了痕迹，
     * 用户无法确认"刚才那段文字到底同步过去没有"。这里记录最近一次的收/发，
     * 供首页展示。只留最近一条，不做剪贴板管理器（SPEC §2.2 明确不做历史）。
     */
    private val _lastClipboard = MutableStateFlow<ClipboardEcho?>(null)
    val lastClipboard: StateFlow<ClipboardEcho?> = _lastClipboard.asStateFlow()

    /** 记录一次收/发，供 UI 展示。由 LinkService 回调。 */
    fun noteClipboard(direction: String, text: String) {
        _lastClipboard.value = ClipboardEcho(
            direction = direction,
            preview = text.take(120).replace("\n", " "),
            chars = text.length,
            at = Instant.now(),
        )
    }

    fun dismissClipboard() {
        _lastClipboard.value = null
    }

    val isPaired: Boolean get() = _config.value.token.isNotBlank()

    init {
        refresh()
        viewModelScope.launch {
            configStore.config.collect { _config.value = it }
        }
        // 持续跟踪连接状态。
        // 早先只在 refresh() 里取一次快照，结果配对成功后 UI 一直显示"未连接" ——
        // 因为那次快照发生在 Link 建立之前。必须订阅，而不是轮询一次。
        viewModelScope.launch {
            var lastStashVersion = -1L
            var lastRejected = false
            while (true) {
                val svc = LinkService.instance
                val st = svc?.linkState ?: LinkState.DISCONNECTED
                _linkState.value = st

                // 把 Service 的剪贴板活动接到 UI。重复注册无害（同一个 lambda 覆盖）。
                if (svc != null) {
                    svc.clipboardObserver = { direction, text -> noteClipboard(direction, text) }
                }

                // **无条件**刷新 Stash。
                //
                // 早先只在 st == CONNECTED 时刷新，结果是：图已经落盘了，但只要连接状态
                // 因为任何原因不是 CONNECTED（重连中、状态流还没更新），
                // 首页就一直显示"还没有收到截图" —— 用户以为没收到，实际已经在磁盘上。
                //
                // 每秒读一次磁盘太浪费，所以先在 Service 侧维护一个「Stash 版本号」，
                // 只有版本变化时才重新读。
                val currentVersion = svc?.stashVersion ?: 0L
                if (currentVersion != lastStashVersion) {
                    lastStashVersion = currentVersion
                    _items.value = stashStore.list()
                }

                if (st == LinkState.CONNECTED) {
                    lastRejected = false
                }

                // 配对失效：清掉本地 token，把用户送回扫码页。
                // 不这么做的话，App 会永远停在"未连接"，而"重新配对"按钮看起来也没反应 ——
                // 因为旧的 401 重连循环还在后台打断新的配对尝试。
                if (st == LinkState.TOKEN_REJECTED && !lastRejected) {
                    lastRejected = true
                    Log.w(TAG, "配对已失效，清除本地 token")
                    configStore.clearPairing()
                    _message.value = "配对已失效，请重新扫描电脑上的二维码"
                } else if (st != LinkState.TOKEN_REJECTED) {
                    lastRejected = false
                }

                delay(1000)
            }
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _items.value = stashStore.list()
            _linkState.value = LinkService.instance?.linkState ?: LinkState.DISCONNECTED
        }
    }

    // ── Stash 操作 ─────────────────────────────────────────

    fun save(item: StashItem) {
        viewModelScope.launch {
            _busy.value = true
            val ok = stashStore.save(item) { file, base ->
                withContext(Dispatchers.IO) {
                    GallerySaver.savePng(context, file, base)
                }
            }
            _items.value = stashStore.list()
            _message.value = if (ok) "已保存到相册" else "保存失败"
            _busy.value = false
        }
    }

    fun discard(item: StashItem) {
        viewModelScope.launch {
            stashStore.discard(item)
            _items.value = stashStore.list()
        }
    }

    fun saveSelected() {
        val chosen = _items.value.filter { it.id in _selection.value }
        if (chosen.isEmpty()) return
        viewModelScope.launch {
            _busy.value = true
            var ok = 0
            for (item in chosen) {
                val saved = stashStore.save(item) { file, base ->
                    withContext(Dispatchers.IO) { GallerySaver.savePng(context, file, base) }
                }
                if (saved) ok++
            }
            _items.value = stashStore.list()
            _selection.value = emptySet()
            _message.value = "已保存 $ok 张到相册"
            _busy.value = false
        }
    }

    fun discardSelected() {
        val chosen = _items.value.filter { it.id in _selection.value }
        if (chosen.isEmpty()) return
        viewModelScope.launch {
            stashStore.discardAll(chosen)
            _items.value = stashStore.list()
            _selection.value = emptySet()
        }
    }

    fun toggleSelection(id: String) {
        _selection.value = _selection.value.let {
            if (it.contains(id)) it - id else it + id
        }
    }

    fun clearSelection() {
        _selection.value = emptySet()
    }

    fun clearMessage() {
        _message.value = null
    }

    /** 按日期分组：今天 / 昨天 / 具体日期。 */
    fun grouped(): List<Pair<String, List<StashItem>>> {
        val now = Instant.now()
        val today = now.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        return _items.value
            .groupBy { item ->
                val d = item.arrivedAt.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                when (d) {
                    today -> "今天"
                    today.minusDays(1) -> "昨天"
                    else -> "${d.monthValue} 月 ${d.dayOfMonth} 日"
                }
            }
            .toList()
    }

    // ── 配对与设置 ─────────────────────────────────────────

    fun pairFromQr(raw: String) {
        val payload = Pairing.parseQr(raw)
        if (payload == null) {
            _message.value = "无效的二维码"
            return
        }
        viewModelScope.launch {
            _busy.value = true
            val name = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"
            val res = Pairing.pair(payload, name, android.os.Build.MODEL)
            if (res == null) {
                _message.value = "配对失败，请确认电脑上的二维码未过期"
            } else {
                configStore.savePairing(
                    token = res.token,
                    address = res.address,
                    fingerprint = res.fingerprint,
                    pairedAt = Instant.now().toString(),
                )
                _items.value = stashStore.list()
                _message.value = "配对成功"
                startService()
                LinkService.instance?.reconnectWith(configStore.current())
            }
            _busy.value = false
        }
    }

    fun setRetentionDays(days: Int) {
        viewModelScope.launch {
            runCatching { configStore.setRetentionDays(days) }
                .onFailure { _message.value = "无效的保留期" }
        }
    }

    fun setServiceEnabled(enabled: Boolean) {
        viewModelScope.launch {
            configStore.setServiceEnabled(enabled)
            if (enabled) startService() else stopService()
        }
    }

    fun unpair() {
        viewModelScope.launch {
            stopService()
            configStore.clearPairing()
            _message.value = "已解除配对"
        }
    }

    fun startService() {
        val intent = Intent(context, LinkService::class.java).apply {
            action = LinkService.ACTION_START
        }
        runCatching {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }.onFailure { _message.value = "启动服务失败：${it.message}" }
    }

    fun stopService() {
        context.stopService(Intent(context, LinkService::class.java))
        _linkState.value = LinkState.DISCONNECTED
    }

    fun stashSizeBytes(): Long = _items.value.sumOf { it.bytes }
}


