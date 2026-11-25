package com.linkok.app.ui

import android.content.Context
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Row
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
    val busy by vm.busy.collectAsStateWithLifecycle()
    val config by vm.config.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()

    // 配对失败必须**看得见**。
    //
    // 原先这条链路是断的：LinkViewModel 把错误写进 _message，靠 Snackbar 显示，
    // 而 PairingScreen 里根本没有 SnackbarHost —— 于是"无效的二维码"、
    // "配对失败"这些话全部被静默丢弃，用户看到的就是"点了没反应也没提示"。
    //
    // 现在双保险：Snackbar + 页面内常驻的错误文字（Snackbar 会消失，文字不会）。
    val snackbar = remember { SnackbarHostState() }
    var lastError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(message) {
        message?.let {
            lastError = it
            snackbar.showSnackbar(it)
            vm.clearMessage()
        }
    }

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
        vm.pairFromQr(contents)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
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

            if (lastError != null && config.token.isBlank() && !busy) {
                Spacer(Modifier.height(12.dp))
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = lastError ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { lastError = null }) {
                            Icon(
                                Icons.Outlined.Close,
                                contentDescription = "关闭提示",
                                tint = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                }
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
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // 从剪贴板粘贴。
                    //
                    // 为什么必须有：手打这个链接几乎不可能成功 —— 输入法会把
                    // "://"、"?"、"&"、"=" 吞掉或错位（实测 linkok://pair?...
                    // 会变成 inklokpairhost96885）。电脑端的「复制配对链接」按钮
                    // 把链接放进剪贴板，这里一键读出来即可，不经过键盘。
                    OutlinedButton(
                        onClick = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                                as android.content.ClipboardManager
                            val text = runCatching {
                                cm.primaryClip?.takeIf { it.itemCount > 0 }
                                    ?.getItemAt(0)?.coerceToText(context)?.toString()
                            }.getOrNull()
                            if (text.isNullOrBlank()) {
                                lastError = "剪贴板是空的。先在电脑窗口点「换个配对码」，再回到这里粘贴。"
                            } else if (!text.trim().startsWith("linkok://", ignoreCase = true)) {
                                lastError = "剪贴板里的内容不是配对链接。请先在电脑窗口点「换个配对码」。"
                            } else {
                                manual = text.trim()
                                lastError = null
                            }
                        },
                        modifier = Modifier.weight(1f),
                    ) { Text("从剪贴板粘贴") }

                    Button(
                        onClick = { vm.pairFromQr(manual.trim()) },
                        enabled = manual.isNotBlank() && !busy,
                        modifier = Modifier.weight(1f),
                    ) { Text(if (busy) "配对中…" else "确认配对") }
                }
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

            // 配对页也显示版本：用户最容易卡在这一页，
            // 如果版本只在设置页，就无从确认当前装的是哪一版。
            Spacer(Modifier.height(32.dp))
            Text(
                text = "LinkOK ${com.linkok.app.BuildConfig.VERSION_NAME} · 构建 ${com.linkok.app.BuildConfig.BUILD_TIME}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
