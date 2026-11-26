package com.linkok.app.service

import com.linkok.app.core.AppLog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.linkok.app.core.ConfigStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 开机自启：重新拉起前台服务。
 *
 * 注意：MIUI 还会额外拦截自启动，需要用户在系统设置里允许（首次引导会提示）。
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }
        AppLog.i(TAG, "收到 $action，准备启动服务")

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val cfg = ConfigStore(context.applicationContext).current()
                if (cfg.token.isBlank()) {
                    AppLog.i(TAG, "尚未配对，不启动服务")
                    return@launch
                }
                if (!cfg.serviceEnabled) {
                    AppLog.i(TAG, "用户已关闭服务，不自动启动")
                    return@launch
                }
                val svc = Intent(context, LinkService::class.java).apply {
                    this.action = LinkService.ACTION_START
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(svc)
                } else {
                    context.startService(svc)
                }
                AppLog.i(TAG, "服务已拉起")
            } catch (e: Exception) {
                AppLog.e(TAG, "启动服务失败", e)
            } finally {
                pending.finish()
            }
        }
    }
}
