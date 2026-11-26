package com.linkok.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.lifecycle.ViewModelProvider
import com.linkok.app.ui.AppRoot
import com.linkok.app.ui.LinkOKTheme
import com.linkok.app.ui.LinkViewModel

class MainActivity : ComponentActivity() {

    private lateinit var vm: LinkViewModel

    /** 深链带来的配对链接；setContent 之后由 AppRoot 消费。 */
    private var pendingPayload by mutableStateOf<String?>(null)

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.CAMERA] == false) {
                Toast.makeText(this, "未授权相机，无法扫码配对", Toast.LENGTH_LONG).show()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                result[Manifest.permission.POST_NOTIFICATIONS] == false
            ) {
                Toast.makeText(this, "未授权通知，状态栏不会显示运行状态", Toast.LENGTH_LONG).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        vm = ViewModelProvider(this)[LinkViewModel::class.java]

        pendingPayload = payloadFrom(intent)

        setContent {
            LinkOKTheme {
                AppRoot(
                    vm = vm,
                    onRequestPermissions = ::requestRuntimePermissions,
                    onOpenAccessibility = ::openAccessibilitySettings,
                    pendingPayload = pendingPayload,
                )
            }
        }

        // 不在启动时就请求相机权限。
        //
        // 早先在这里无条件调 requestRuntimePermissions()，结果是 App 一打开、
        // 用户还停在欢迎页，系统就弹出「是否允许拍摄照片」——用户根本还不知道
        // 这个 App 要干什么，很容易点拒绝。
        //
        // 现在权限由真正需要它的页面（扫码页）自己在进入时申请。
        // 通知权限仍在这里要，因为它不打断任何流程。
        requestNotificationPermission()

        // 已配对就拉起前台服务。
        //
        // 关键：isPaired 读的是 _config.value.token，而 _config 是在 ViewModel
        // 的 init 协程里异步加载的 —— onCreate 这一刻它还是空值，所以
        // `if (vm.isPaired) startService()` 永远不成立，服务从未被启动，
        // 手机也就永远连不上电脑（现象是首页一直显示「电脑未连接」）。
        //
        // 现在订阅配置流：一旦读到 token 就启动服务；已经启动过则忽略。
        lifecycleScope.launch {
            vm.config.collect { cfg ->
                if (cfg.token.isNotBlank() && !serviceStarted) {
                    serviceStarted = true
                    vm.startService()
                }
            }
        }
    }

    /** 防止配置流多次发射时重复启动服务。 */
    private var serviceStarted = false

    /**
     * 只请求通知权限。
     *
     * 相机权限交给扫码页按需申请；相册权限**不申请** —— 「从相册识别」走的是
     * 系统相册选择器（`ActivityResultContracts.GetContent`），它自己会授权单张图片，
     * 不需要 READ_MEDIA_IMAGES。
     *
     * 早先在这里一次性把相机和相册都请求了，结果用户在欢迎页还没看清 App 是
     * 干什么的，就先被连问两次权限。
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        requestPermissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
    }

    /**
     * launchMode=singleTask 下，点链接时不会再走 onCreate，
     * 而是把新的 Intent 送到这里。
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val payload = payloadFrom(intent)
        if (payload != null) {
            pendingPayload = payload
        }
    }

    private fun payloadFrom(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (!data.scheme.equals("linkok", ignoreCase = true)) return null
        if (!data.host.equals("pair", ignoreCase = true)) return null
        return data.toString()
    }

    /**
     * 兼容入口：AppRoot 的回调签名仍要求它存在。
     *
     * 实际上相机权限已由扫码页按需申请，这里只补通知/相册权限，
     * 并且只在首次调用时执行 —— 否则用户每进一次配对页就会被弹一次。
     */
    private fun requestRuntimePermissions() {
        requestNotificationPermission()
    }

    /**
     * 打开系统的无障碍设置页。
     *
     * MIUI 会随手关掉无障碍服务，所以这是必须暴露给用户的一键入口。
     * 见 SPEC §5.4 与 ADR 0002。
     */
    private fun openAccessibilitySettings() {
        runCatching {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }.onFailure {
            Toast.makeText(this, "无法打开无障碍设置，请手动进入系统设置", Toast.LENGTH_LONG).show()
        }
    }
}
