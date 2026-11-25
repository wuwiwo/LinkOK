package com.linkok.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.linkok.app.service.LinkService

/**
 * 用于「手机复制 → 电脑剪贴板」的无障碍服务。
 *
 * 为什么需要它：Android 10 (API 29) 起，应用只有在**处于前台**或**是默认输入法**时
 * 才能读取剪贴板。要在后台自动上行手机复制的内容，无障碍服务是唯一途径。
 * 见 ADR 0002 与 SPEC §5.4。
 *
 * 已知代价（已在 ADR 0002 记录为「接受」）：
 * - MIUI 会在重启或长时间不用后关闭无障碍服务，需要用户重新开启。
 * - 因此保留降级路径：快捷设置磁贴 + App 前台时自动推送。
 */
class ClipboardAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ClipAccessibility"

        /** 最近一次成功上行的文本哈希，避免同一内容被事件反复触发时重复推送。 */
        @Volatile
        private var lastPushed: String? = null

        /** 是否已连接，UI 可据此显示状态。 */
        @Volatile
        var isRunning: Boolean = false
            private set
    }

    private lateinit var clipboard: ClipboardManager

    override fun onServiceConnected() {
        super.onServiceConnected()
        clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        isRunning = true
        Log.i(TAG, "无障碍服务已连接")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 只在界面内容变化时尝试读取，避免高频轮询。
        // 事件类型不作为唯一依据：不同 App 复制后的表现不同。
        if (event == null) return
        if (!isAllowedEvent(event)) return
        pushCurrentClipboard()
    }

    private fun isAllowedEvent(event: AccessibilityEvent): Boolean =
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
            -> true
            else -> false
        }

    private fun pushCurrentClipboard() {
        val clip = runCatching { clipboard.primaryClip }.getOrNull() ?: return
        if (clip.itemCount == 0) return

        val text = clip.getItemAt(0).coerceToText(this)?.toString() ?: return
        if (text.isBlank()) return

        val hash = hash(text)
        if (hash == lastPushed) return

        val svc = LinkService.instance ?: return
        lastPushed = hash
        svc.pushClipboardToHub(text)
        Log.d(TAG, "已上行剪贴板 (${text.length} 字符)")
    }

    /** 供磁贴或 UI 主动触发一次上行。 */
    fun pushNow() = pushCurrentClipboard()

    override fun onInterrupt() {
        Log.w(TAG, "无障碍服务被中断")
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun hash(s: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
