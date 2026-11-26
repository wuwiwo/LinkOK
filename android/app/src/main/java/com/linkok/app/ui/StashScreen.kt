package com.linkok.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.material.icons.outlined.Check
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.SaveAlt
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import android.content.Context
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.linkok.app.accessibility.ClipboardAccessibilityService
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.linkok.app.core.StashItem
import com.linkok.app.net.LinkState
import java.io.File

/**
 * 手机端主界面：单页 Stash。
 *
 * 结构见 SPEC §6.2：连接状态条 → 最新一张大图卡 → 日期分组缩略图网格。
 * 「一个记忆点」的克制原则：全页只有大图卡是视觉重心，其余安静。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StashScreen(
    vm: LinkViewModel,
    onOpenSettings: () -> Unit,
    onOpenAccessibility: () -> Unit = {},
) {
    val items by vm.items.collectAsStateWithLifecycle()
    val link by vm.linkState.collectAsStateWithLifecycle()
    val message by vm.message.collectAsStateWithLifecycle()
    val selection by vm.selection.collectAsStateWithLifecycle()
    val lastClipboard by vm.lastClipboard.collectAsStateWithLifecycle()

    // 正在查看大图的条目；null 表示未打开。
    var viewerItem by remember { mutableStateOf<StashItem?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            vm.clearMessage()
        }
    }

    val grouped = remember(items) {
        val now = java.time.LocalDate.now()
        items.groupBy { item ->
            val d = item.arrivedAt.atZone(java.time.ZoneId.systemDefault()).toLocalDate()
            when (d) {
                now -> "今天"
                now.minusDays(1) -> "昨天"
                else -> "${d.monthValue} 月 ${d.dayOfMonth} 日"
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (selection.isEmpty()) "LinkOK" else "已选 ${selection.size} 项",
                        style = MaterialTheme.typography.titleLarge,
                    )
                },
                actions = {
                    if (selection.isNotEmpty()) {
                        IconButton(onClick = { vm.saveSelected() }) {
                            Icon(Icons.Outlined.SaveAlt, contentDescription = "保存所选")
                        }
                        IconButton(onClick = { vm.discardSelected() }) {
                            Icon(Icons.Outlined.DeleteOutline, contentDescription = "丢弃所选")
                        }
                    } else {
                        IconButton(onClick = onOpenSettings) {
                            Icon(Icons.Outlined.Settings, contentDescription = "设置")
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ConnectionBar(link)

            // 无障碍没开 → 手机→电脑的剪贴板同步是断的。
            // 这个提醒要显眼但可关闭，否则用户会一直奇怪"为什么手机上复制的东西电脑收不到"。
            AccessibilityNotice(
                onOpenSettings = onOpenAccessibility,
            )

            // 最近一次剪贴板同步。没有就不占空间。
            ClipboardCard(
                echo = lastClipboard,
                onDismiss = { vm.dismissClipboard() },
            )

            if (items.isEmpty()) {
                EmptyState(modifier = Modifier.weight(1f))
            } else {
                LazyVerticalGrid(
                    // 2 列。3 列在 1080p 上每格只有 ~110dp，截图里的文字完全看不清，
                    // 而截图的主要价值就是"看清上面写了什么"。
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    grouped.forEach { (label, group) ->
                        item(span = { GridItemSpan(maxLineSpan) }, key = "h-$label") {
                            Text(
                                text = label,
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
                            )
                        }
                        items(group, key = { it.id }) { item ->
                            Thumb(
                                item = item,
                                selected = item.id in selection,
                                selectionMode = selection.isNotEmpty(),
                                onClick = {
                                    // 点 = 看大图（这是最主要的动作：先看清内容，再决定存或丢）
                                    // 多选态下点 = 切换选中。
                                    if (selection.isNotEmpty()) vm.toggleSelection(item.id)
                                    else viewerItem = item
                                },
                                onLongClick = { vm.toggleSelection(item.id) },
                            )
                        }
                    }
                }
            }
        }
    }

    // ── 全屏查看大图 ──
    viewerItem?.let { item ->
        ImageViewer(
            item = item,
            onDismiss = { viewerItem = null },
            onSave = {
                vm.save(item)
                viewerItem = null
            },
            onDiscard = {
                vm.discard(item)
                viewerItem = null
            },
        )
    }
}

/**
 * 最近一次剪贴板同步。
 *
 * 用户的原话是"复制的文本也要显示"。之前剪贴板同步完全透明：
 * 内容进了系统剪贴板，界面上没有任何痕迹，无法确认到底同步了没有、同步的是什么。
 *
 * 只显示最近一条，且给一个关闭按钮 —— 这是观察用的，不是剪贴板管理器。
 */
@Composable
private fun ClipboardCard(echo: ClipboardEcho?, onDismiss: () -> Unit) {
    if (echo == null) return

    val directionText = if (echo.direction == "inbound") "从电脑同步过来" else "已发送到电脑"
    val arrow = if (echo.direction == "inbound") "←" else "→"

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = "$arrow 剪贴板 · $directionText",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = echo.preview,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                if (echo.chars > echo.preview.length) {
                    Text(
                        text = "共 ${echo.chars} 个字符",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onDismiss) {
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = "关闭",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * 无障碍未开启时的提醒条。
 *
 * 为什么需要：无障碍服务是「手机复制 → 电脑」的唯一路径（Android 10+ 限制），
 * 没开时那条链路是断的。之前用户只能在设置页深处看到，首页毫无提示，
 * 表现就是"手机上复制了东西，电脑收不到，不知道为什么"。
 *
 * 可以关掉（记住到下一次启动），但不能永久隐藏 —— 它是功能缺失的说明，
 * 不是广告。用户明确点过 × 之后本次运行不再打扰。
 */
@Composable
private fun AccessibilityNotice(onOpenSettings: () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("linkok_ui", Context.MODE_PRIVATE) }
    var dismissed by remember { mutableStateOf(prefs.getBoolean("a11y_notice_dismissed", false)) }

    // 无障碍已开就不显示。
    val enabled = remember { ClipboardAccessibilityService.isRunning }

    if (enabled || dismissed) return

    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = "手机复制的内容还不会同步到电脑",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
                Text(
                    text = "需要开启无障碍服务",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
            TextButton(onClick = onOpenSettings) { Text("去开启") }
            IconButton(onClick = {
                dismissed = true
                prefs.edit().putBoolean("a11y_notice_dismissed", true).apply()
            }) {
                Icon(
                    Icons.Outlined.Close,
                    contentDescription = "关闭提醒",
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
        }
    }
}

/** 连接状态条：圆点 + 文字。绝不只靠颜色传达状态（SPEC §6.1）。 */
@Composable
private fun ConnectionBar(state: LinkState) {
    val (text, dotColor) = when (state) {
        LinkState.CONNECTED -> "已连接" to MaterialTheme.colorScheme.primary
        LinkState.CONNECTING -> "正在连接" to MaterialTheme.colorScheme.tertiary
        LinkState.DISCONNECTED -> "电脑未连接" to MaterialTheme.colorScheme.outline
        LinkState.TOKEN_REJECTED -> "配对已失效 · 请重新扫码" to MaterialTheme.colorScheme.error
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(dotColor, CircleShape),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 最新一张：28dp 圆角，符合 M3 形状标度（SPEC §6.1）。 */
@Composable
private fun LatestCard(
    item: StashItem,
    onSave: () -> Unit,
    onDiscard: () -> Unit,
) {
    Card(
        shape = RoundedCornerShape(28.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            // 内层 20dp：外 28 = 内 20 + 内边距 8 + 边框 0（同心圆角，见 SPEC §6.1）
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(0.6f)
                    .background(
                        MaterialTheme.colorScheme.surfaceVariant,
                        RoundedCornerShape(20.dp),
                    ),
            ) {
                ThumbnailImage(
                    file = File(item.fileName),
                    modifier = Modifier.fillMaxSize(),
                    cornerRadius = 20.dp,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onSave,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(50),
                ) { Text("保存") }
                OutlinedButton(
                    onClick = onDiscard,
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(50),
                ) { Text("丢弃") }
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Thumb(
    item: StashItem,
    selected: Boolean,
    selectionMode: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    // 卡片式缩略图：
    //   - 外层 20dp 圆角 + 表面色底，内层 16dp 圆角图（同心：20 = 16 + 4 内边距）
    //   - 未选中时用 outlineVariant 极细描边，让浅色截图不糊进背景
    //   - 选中时描边换成 primary 并加粗，且右上角出现对勾
    val shape = RoundedCornerShape(20.dp)
    val innerShape = RoundedCornerShape(16.dp)
    val strokeColor = when {
        selected -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.outlineVariant
    }
    val strokeWidth = if (selected) 2.dp else 1.dp

    Box(
        modifier = Modifier
            .aspectRatio(0.62f)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(strokeWidth, strokeColor, shape)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .padding(4.dp),
    ) {
        ThumbnailImage(
            file = File(item.fileName),
            modifier = Modifier.fillMaxSize(),
            cornerRadius = 16.dp,
        )

        // 选中标记
        if (selected) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(24.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.Check,
                    contentDescription = "已选中",
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }

        // 底部时间戳：只在多选态下显示会显得突兀，所以常驻但极淡。
        // 用户需要知道这张是"什么时候"收到的。
        val timeText = remember(item.id) {
            java.time.format.DateTimeFormatter.ofPattern("HH:mm")
                .withZone(java.time.ZoneId.systemDefault())
                .format(item.arrivedAt)
        }
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(6.dp)
                .background(Color.Black.copy(alpha = 0.45f), RoundedCornerShape(50))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        ) {
            Text(
                text = timeText,
                style = MaterialTheme.typography.labelSmall,
                color = Color.White,
            )
        }
    }
}

/**
 * 全屏查看大图。
 *
 * 为什么必须有：截图的价值在于"看清上面写了什么"，缩略图做不到这件事。
 * 之前点缩略图会直接保存（危险且不可逆），现在改成先看大图，
 * 在图上决定保存还是丢弃。
 *
 * 交互：
 *   - 点任意区域 / 按返回 → 关闭
 *   - 双指缩放 / 拖动查看细节
 *   - 底部两个按钮：保存 / 丢弃
 */
@Composable
private fun ImageViewer(
    item: StashItem,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    onDiscard: () -> Unit,
) {
    // 返回键先关掉查看器，而不是退出 App。
    androidx.activity.compose.BackHandler(enabled = true) { onDismiss() }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
        ) {
            // 大图，支持缩放与拖动
            val bitmap = remember(item.id) {
                runCatching {
                    BitmapFactory.decodeFile(item.fileName)?.asImageBitmap()
                }.getOrNull()
            }
            var scale by remember { mutableStateOf(1f) }
            var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }

            if (bitmap != null) {
                Image(
                    bitmap = bitmap,
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(item.id) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(1f, 6f)
                                offset = if (scale > 1f) offset + pan else androidx.compose.ui.geometry.Offset.Zero
                            }
                        }
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            translationX = offset.x
                            translationY = offset.y
                        },
                )
            } else {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("图片无法加载", color = Color.White)
                }
            }

            // 顶部：关闭 + 时间
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) {
                    Icon(
                        Icons.Outlined.Close,
                        contentDescription = "关闭",
                        tint = Color.White,
                    )
                }
                Spacer(Modifier.width(4.dp))
                Text(
                    text = java.time.format.DateTimeFormatter
                        .ofPattern("M月d日 HH:mm")
                        .withZone(java.time.ZoneId.systemDefault())
                        .format(item.arrivedAt),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White.copy(alpha = 0.75f),
                )
                Spacer(Modifier.weight(1f))
                if (scale > 1f) {
                    TextButton(onClick = {
                        scale = 1f
                        offset = androidx.compose.ui.geometry.Offset.Zero
                    }) {
                        Text("还原", color = Color.White.copy(alpha = 0.85f))
                    }
                }
            }

            // 底部操作
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onSave,
                    modifier = Modifier
                        .weight(1f)
                        .height(50.dp),
                    shape = RoundedCornerShape(50),
                ) { Text("保存到相册") }

                OutlinedButton(
                    onClick = onDiscard,
                    modifier = Modifier
                        .weight(1f)
                        .height(50.dp),
                    shape = RoundedCornerShape(50),
                    colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                        contentColor = Color.White,
                    ),
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        Color.White.copy(alpha = 0.5f),
                    ),
                ) { Text("丢弃") }
            }
        }
    }
}

@Composable
private fun ThumbnailImage(file: File, modifier: Modifier, cornerRadius: androidx.compose.ui.unit.Dp) {
    val bitmap = remember(file.absolutePath) {
        if (file.exists()) {
            BitmapFactory.decodeFile(file.absolutePath)?.asImageBitmap()
        } else null
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = modifier.clip(RoundedCornerShape(cornerRadius)),
        )
    } else {
        Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Icon(
                Icons.Outlined.CloudOff,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** 空状态必须给一个明确的下一步（SPEC §6.2 / DESIGN-GUIDE §10）。 */
@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Outlined.CloudOff,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = "还没有收到截图",
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "在电脑上截图，它会出现在这里",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}




