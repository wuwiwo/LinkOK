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

        requestRuntimePermissions()
        if (vm.isPaired) vm.startService()
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

    private fun requestRuntimePermissions() {
        val wanted = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            wanted += Manifest.permission.CAMERA
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                wanted += Manifest.permission.POST_NOTIFICATIONS
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES)
                != PackageManager.PERMISSION_GRANTED
            ) {
                wanted += Manifest.permission.READ_MEDIA_IMAGES
            }
        }
        if (wanted.isNotEmpty()) {
            requestPermissions.launch(wanted.toTypedArray())
        }
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
