package com.linkok.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import com.linkok.app.core.AppLog
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 配对页。
 *
 * 版式参考了常见的桌面端远控 App：标题 + 一行说明 + **内嵌相机取景框**（四角标记）
 * + 「从相册识别」+ 「粘贴配对链接」。
 *
 * 为什么不用 zxing 的 ScanContract：它会弹出一个全屏 Activity，
 * 无法做成页内取景框，也无法在同一页里同时给出"粘贴"这条降级路径。
 * 现在预览交给 CameraX，解码仍用 zxing 的 core（Reader）。
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
    val lifecycleOwner = LocalLifecycleOwner.current
    val busy by vm.busy.collectAsStateWithLifecycle()
    val config by vm.config.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()

    val snackbar = remember { SnackbarHostState() }
    var lastError by remember { mutableStateOf<String?>(null) }
    var showManual by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf("") }

    // 相机权限
    var hasCamera by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        AppLog.i("PairingScreen", "相机权限: $granted")
        hasCamera = granted
        if (!granted) {
            lastError = "未授权相机。可以点「从相册识别」或「粘贴配对链接」。"
        }
    }

    LaunchedEffect(Unit) {
        AppLog.i("PairingScreen", "进入扫码页 canSkip=$canSkip")
        if (!hasCamera) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    LaunchedEffect(message) {
        message?.let {
            lastError = it
            snackbar.showSnackbar(it)
            vm.clearMessage()
        }
    }

    // 配对成功后自动离开这一页。
    //
    // 关键：必须记录「进入本页时是否已经配对过」。
    // 点「重新配对」时本地本来就存着旧 token，如果只判断「token 非空 → onDone」，
    // 那么进入扫码页的瞬间就会被弹走 —— 表现就是一闪而过。
    // 只有 token 从「空」变成「非空」，或者显式配对成功后，才该自动离开。
    val tokenAtEntry = remember { config.token }
    LaunchedEffect(config.token) {
        val current = config.token
        if (current.isNotBlank() && current != tokenAtEntry) onDone()
    }

    // 从相册识别
    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val text = QrDecoder.decodeFromUri(context, uri)
        if (text.isNullOrBlank()) {
            lastError = "这张图片里没有识别到二维码。"
        } else if (!text.trim().startsWith("linkok://", ignoreCase = true)) {
            lastError = "识别到的不是 LinkOK 配对二维码。"
        } else {
            lastError = null
            vm.pairFromQr(text.trim())
        }
    }

    /**
     * 已经处理过的二维码内容。
     *
     * 为什么必须去重：CameraX 的 ImageAnalysis 每帧都回调，只要二维码还在取景框里
     * 就会**每帧触发一次配对**。30fps 下 100ms 内能发出 5 次 POST /pair ——
     * 而配对码是一次性的，第一次成功消耗掉之后，后续 4 次必然 mismatch，
     * 直接触发 Hub 的「5 次失败锁定 5 分钟」。
     *
     * 实测日志：16:36:53.458 生成码 → .486/.517/.549/.584/.627 连续 5 次 mismatch → 锁定。
     */
    var lastAttempted by remember { mutableStateOf<String?>(null) }

    // 一次只处理一帧，避免解码把主线程拖死。
    val busyDecode = remember { AtomicBoolean(false) }

    // 配对失败后不要立刻重试同一个码（它已经被消耗了）。
    // 给出明确提示，引导用户去电脑上换个新码。
    LaunchedEffect(message) {
        message?.let {
            lastError = it
            snackbar.showSnackbar(it)
            vm.clearMessage()
        }
    }

    Surface(color = MaterialTheme.colorScheme.surface) {
        Box(Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    // statusBarsPadding：不写的话标题会顶到状态栏下面（实测被
                    // 时间/信号那一行压住）。navigationBarsPadding 同理，否则
                    // 底部版本号会被手势条盖住。
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp),
            ) {
                Spacer(Modifier.height(8.dp))

                // 返回按钮。
                //
                // 参考图的版式是「左上角圆形返回 + 标题」，所以这里始终显示 ——
                // 早先写 `if (canSkip)` 且 canSkip 要求已配对，导致未配对的人
                // 被困在相机页，连系统返回键都会直接退出 App。
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(
                        onClick = onCancel,
                        modifier = Modifier
                            .size(40.dp)
                            .background(
                                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                                CircleShape,
                            ),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "返回",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))

                Text(
                    text = "扫码配对电脑",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "不用注册任何账号，配对信息只在你的局域网内传递",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(16.dp))

                // ── 取景框 ──
                //
                // 高度用 aspectRatio 而不是写死 dp：写死 400dp 在小屏/大字体的
                // 设备上会把下面的说明和按钮挤出屏幕。
                //
                // clip(RoundedCornerShape) 不能省：PreviewView 是原生 View，
                // 它会按自己的测量尺寸铺满并溢出父容器（实测盖住了上方副标题）。
                // 圆角背景只是画在下面，不裁剪子 View。
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(0.85f)
                        .clip(RoundedCornerShape(28.dp))
                        .background(Color(0xFF111111)),
                ) {
                    if (hasCamera) {
                        AndroidView(
                            factory = { ctx ->
                                PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
                            },
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(2.dp),
                            update = { previewView ->
                                bindCamera(
                                    context = context,
                                    lifecycleOwner = lifecycleOwner,
                                    previewView = previewView,
                                    busyDecode = busyDecode,
                                    onDecoded = { text ->
                                        val trimmed = text.trim()
                                        AppLog.i("PairingScreen", "扫到二维码: ${trimmed.take(60)}… 已尝试=${lastAttempted != null}")
                                        if (!trimmed.startsWith("linkok://", ignoreCase = true)) {
                                            // 不是配对码，只在内容变化时提示一次，避免每帧刷。
                                            if (lastAttempted != trimmed) {
                                                lastAttempted = trimmed
                                                lastError = "扫到的不是 LinkOK 配对二维码。"
                                            }
                                        } else if (trimmed != lastAttempted && !busy) {
                                            // 同一个码只试一次。配对码一次性使用，
                                            // 重试只会把 Hub 打到锁定。
                                            lastAttempted = trimmed
                                            vm.pairFromQr(trimmed)
                                        }
                                    },
                                )
                            },
                        )
                        ViewfinderCorners()
                    } else {
                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(
                                "需要相机权限才能扫码",
                                color = Color.White,
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(Modifier.height(12.dp))
                            Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                                Text("授予相机权限")
                            }
                        }
                    }

                    // 右下角：从相册识别
                    Surface(
                        color = Color.Black.copy(alpha = 0.55f),
                        shape = RoundedCornerShape(50),
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(12.dp),
                    ) {
                        TextButton(onClick = { pickImage.launch("image/*") }) {
                            Icon(
                                Icons.Outlined.PhotoLibrary,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.size(6.dp))
                            Text("从相册识别", color = Color.White)
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))
                Text(
                    text = "对准电脑上 LinkOK 窗口显示的配对二维码",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(12.dp))
                // 粘贴配对链接
                TextButton(
                    onClick = { showManual = !showManual },
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                ) {
                    Icon(
                        Icons.Outlined.ContentPaste,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.size(6.dp))
                    Text("粘贴配对链接")
                }

                if (showManual) {
                    Spacer(Modifier.height(8.dp))
                    androidx.compose.material3.OutlinedTextField(
                        value = manual,
                        onValueChange = { manual = it },
                        label = { Text("配对链接") },
                        placeholder = { Text("linkok://pair?host=…&port=…&code=…") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2,
                    )
                    Spacer(Modifier.height(8.dp))
                    androidx.compose.foundation.layout.Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        androidx.compose.material3.OutlinedButton(
                            onClick = {
                                val cm = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
                                    as android.content.ClipboardManager
                                val text = runCatching {
                                    cm.primaryClip?.takeIf { it.itemCount > 0 }
                                        ?.getItemAt(0)?.coerceToText(context)?.toString()
                                }.getOrNull()
                                if (text.isNullOrBlank()) {
                                    lastError = "剪贴板是空的。先在电脑窗口点「换个配对码」。"
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

                if (lastError != null && !busy) {
                    Spacer(Modifier.height(12.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = lastError ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }

                Spacer(Modifier.height(12.dp))
                VersionFooter(modifier = Modifier.align(Alignment.CenterHorizontally))
                Spacer(Modifier.height(8.dp))
            }

            SnackbarHost(
                hostState = snackbar,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

/** 取景框四角标记。 */
@Composable
private fun ViewfinderCorners() {
    Canvas(Modifier.fillMaxSize()) {
        val inset = size.minDimension * 0.14f
        val len = size.minDimension * 0.12f
        val stroke = 3.dp.toPx()
        val color = Color.White

        // 左上
        drawLine(color, Offset(inset, inset), Offset(inset + len, inset), stroke, StrokeCap.Round)
        drawLine(color, Offset(inset, inset), Offset(inset, inset + len), stroke, StrokeCap.Round)
        // 右上
        drawLine(color, Offset(size.width - inset, inset), Offset(size.width - inset - len, inset), stroke, StrokeCap.Round)
        drawLine(color, Offset(size.width - inset, inset), Offset(size.width - inset, inset + len), stroke, StrokeCap.Round)
        // 左下
        drawLine(color, Offset(inset, size.height - inset), Offset(inset + len, size.height - inset), stroke, StrokeCap.Round)
        drawLine(color, Offset(inset, size.height - inset), Offset(inset, size.height - inset - len), stroke, StrokeCap.Round)
        // 右下
        drawLine(color, Offset(size.width - inset, size.height - inset), Offset(size.width - inset - len, size.height - inset), stroke, StrokeCap.Round)
        drawLine(color, Offset(size.width - inset, size.height - inset), Offset(size.width - inset, size.height - inset - len), stroke, StrokeCap.Round)
    }
}

/**
 * 绑定 CameraX 预览 + 分析。
 *
 * 用 DisposableEffect 的作用域在这里拿不到，所以用一个可幂等的绑定函数：
 * 每次 update 都可能调用，重复 unbindAll 再 bind 是幂等的。
 */
private fun bindCamera(
    context: android.content.Context,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
    previewView: PreviewView,
    busyDecode: AtomicBoolean,
    onDecoded: (String) -> Unit,
) {
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener({
        val provider = runCatching { providerFuture.get() }.getOrNull() ?: return@addListener

        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }

        val analysis = ImageAnalysis.Builder()
            .setTargetResolution(Size(1280, 720))
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

        val executor = Executors.newSingleThreadExecutor()
        analysis.setAnalyzer(executor) { imageProxy: ImageProxy ->
            if (!busyDecode.compareAndSet(false, true)) {
                imageProxy.close()
                return@setAnalyzer
            }
            try {
                val text = QrDecoder.decodeFromImageProxy(imageProxy)
                if (!text.isNullOrBlank()) onDecoded(text)
            } finally {
                busyDecode.set(false)
                imageProxy.close()
            }
        }

        runCatching {
            provider.unbindAll()
            provider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis,
            )
        }
    }, ContextCompat.getMainExecutor(context))
}
