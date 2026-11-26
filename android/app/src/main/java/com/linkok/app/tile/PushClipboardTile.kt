package com.linkok.app.tile

import com.linkok.app.core.AppLog
import android.content.Context
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import com.linkok.app.service.LinkService

/**
 * 快捷设置磁贴：一键把手机剪贴板推到电脑。
 *
 * 这是无障碍服务失效时的**降级路径**（见 SPEC §5.4 / ADR 0002）。
 * MIUI 会随手关掉无障碍服务，所以必须留一条不需要该权限的手动通道。
 */
class PushClipboardTile : TileService() {

    companion object {
        private const val TAG = "PushClipboardTile"
    }

    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val connected = LinkService.instance != null
        tile.state = if (connected) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "推送剪贴板"
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        val svc = LinkService.instance
        if (svc == null) {
            AppLog.w(TAG, "服务未运行，无法推送")
            flashTile(false)
            return
        }
        // 解锁后读剪贴板：Android 10+ 要求在前台状态下读取。
        unlockAndRun {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val text = runCatching {
                cm.primaryClip?.takeIf { it.itemCount > 0 }
                    ?.getItemAt(0)?.coerceToText(this)?.toString()
            }.getOrNull()

            if (text.isNullOrBlank()) {
                flashTile(false)
                return@unlockAndRun
            }
            svc.pushClipboardToHub(text)
            flashTile(true)
        }
        qsTile?.updateTile()
    }

    private fun flashTile(ok: Boolean) {
        val tile = qsTile ?: return
        tile.state = if (ok) Tile.STATE_ACTIVE else Tile.STATE_UNAVAILABLE
        tile.updateTile()
    }
}
