package com.linkok.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.activity.compose.rememberLauncherForActivityResult

/**
 * 配对引导。
 *
 * 两条路径：
 * 1. **扫码**（主路径，SPEC §5.5）—— 用 zxing 打开相机扫电脑上的二维码。
 * 2. **粘贴链接**（降级）—— 相机权限被拒、光线太差、或二维码显示在别的屏幕上时用。
 *
 * 两条路径最终都产出同一个 `linkok://pair?...` 字符串，交给 [LinkViewModel.pairFromQr]。
 */
@Composable
fun PairingScreen(
    vm: LinkViewModel,
    canSkip: Boolean,
    onDone: () -> Unit,
    onCancel: () -> Unit,
    onRequestPermissions: () -> Unit,
) {
    val context = LocalContext.current
    var manual by remember { mutableStateOf("") }
    var showManual by remember { mutableStateOf(false) }
    var lastScanned by remember { mutableStateOf<String?>(null) }
    val busy by vm.busy.collectAsStateWithLifecycle()
    val config by vm.config.collectAsStateWithLifecycle()

    // 配对成功后自动进入主界面。
    LaunchedEffect(config.token) {
        if (config.token.isNotBlank()) onDone()
    }

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents.isNullOrBlank()) {
            // 用户取消扫描：什么都不做，不要当成错误。
            return@rememberLauncherForActivityResult
        }
        lastScanned = contents
        vm.pairFromQr(contents)
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = "连接你的电脑",
                style = MaterialTheme.typography.headlineSmall,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "在电脑的控制台窗口里找到配对码，然后扫描它旁边的链接二维码。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))

            Button(
                onClick = {
                    onRequestPermissions()
                    val options = ScanOptions().apply {
                        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        setPrompt("对准电脑上的二维码")
                        setBeepEnabled(false)
                        setOrientationLocked(false)
                        // 默认用 zxing 自带的 CaptureActivity，不需要额外声明 Activity。
                    }
                    runCatching { scanLauncher.launch(options) }
                        .onFailure { showManual = true }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("扫码配对") }

            if (lastScanned != null && config.token.isBlank() && !busy) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "已读取二维码，但配对未完成。可改用下方的粘贴方式。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            }

            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { showManual = !showManual }) {
                Text(if (showManual) "收起手动输入" else "扫码不方便？粘贴配对链接")
            }

            if (showManual) {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = manual,
                    onValueChange = { manual = it },
                    label = { Text("配对链接") },
                    placeholder = { Text("linkok://pair?host=…&port=…&code=…") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = false,
                    minLines = 2,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = { vm.pairFromQr(manual.trim()) },
                    enabled = manual.isNotBlank() && !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (busy) "配对中…" else "确认配对") }
            }

            if (busy) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "正在连接电脑…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (canSkip) {
                Spacer(Modifier.height(16.dp))
                OutlinedButton(onClick = onCancel) { Text("取消") }
            }
        }
    }
}
