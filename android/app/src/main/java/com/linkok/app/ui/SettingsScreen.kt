package com.linkok.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.linkok.app.accessibility.ClipboardAccessibilityService
import com.linkok.app.net.LinkState

/**
 * 设置页。
 *
 * 结构与 PC 设置页对齐（SPEC §6.3）：分组用扁平列表行 + 分隔线，
 * 不装箱成一叠等权卡片。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    vm: LinkViewModel,
    onBack: () -> Unit,
    onRepair: () -> Unit,
    onOpenAccessibility: () -> Unit,
) {
    val config by vm.config.collectAsStateWithLifecycle()
    val link by vm.linkState.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置", style = MaterialTheme.typography.titleLarge) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionHeader("连接")

            val statusText = when (link) {
                LinkState.CONNECTED -> "已连接"
                LinkState.CONNECTING -> "正在连接"
                LinkState.DISCONNECTED -> "电脑未连接"
                LinkState.TOKEN_REJECTED -> "配对已失效，请重新配对"
            }
            SettingRow(
                title = "状态",
                subtitle = statusText,
                trailing = {
                    Box(
                        Modifier
                            .size(8.dp)
                            .background(
                                if (link == LinkState.CONNECTED) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.outline,
                                CircleShape,
                            )
                    )
                },
            )
            SettingRow(
                title = "电脑地址",
                subtitle = config.hubAddress.ifBlank { "尚未配对" },
            )
            ActionRow(
                title = "重新配对",
                subtitle = "扫描电脑上的新二维码",
                onClick = onRepair,
            )

            Divider()

            SectionHeader("剪贴板同步")
            val accOn = ClipboardAccessibilityService.isRunning
            SettingRow(
                title = "后台自动同步",
                subtitle = if (accOn) "已开启" else "已关闭 · 只能手动推送",
                trailing = {
                    TextButton(onClick = onOpenAccessibility) {
                        Text(if (accOn) "管理" else "开启")
                    }
                },
            )
            if (!accOn) {
                HintRow("关闭后，手机复制的内容不会自动到电脑。可在快捷设置里添加「推送剪贴板」磁贴手动发送。")
            }

            Divider()

            SectionHeader("保留期")
            RetentionPicker(
                current = config.retentionDays,
                onPick = { vm.setRetentionDays(it) },
            )
            HintRow("超过保留期的截图会自动清理。只清理 LinkOK 自己的暂存区，不会动系统相册。")

            Divider()

            SectionHeader("服务")
            SettingRow(
                title = "后台常驻",
                subtitle = if (config.serviceEnabled) "已开启，关掉后无法自动接收截图" else "已关闭",
                trailing = {
                    Switch(
                        checked = config.serviceEnabled,
                        onCheckedChange = { vm.setServiceEnabled(it) },
                    )
                },
            )

            Spacer(Modifier.height(8.dp))
            ActionRow(
                title = "解除配对",
                subtitle = "清除本机保存的令牌",
                onClick = { vm.unpair() },
                destructive = true,
            )

            Spacer(Modifier.height(24.dp))
            Text(
                text = "LinkOK 0.1.0",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 8.dp),
    )
}

/** 扁平设置行：不装箱成卡片（SPEC §6.3）。 */
@Composable
private fun SettingRow(
    title: String,
    subtitle: String? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        trailing?.invoke()
    }
}

@Composable
private fun ActionRow(
    title: String,
    subtitle: String? = null,
    onClick: () -> Unit,
    destructive: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (destructive) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurface,
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun HintRow(text: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(12.dp),
        )
    }
}

@Composable
private fun Divider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(top = 8.dp),
    )
}

/** 保留期：7 / 15 / 30 / 永不，默认 30（SPEC §5.6）。 */
@Composable
private fun RetentionPicker(current: Int, onPick: (Int) -> Unit) {
    val options = listOf(7 to "7 天", 15 to "15 天", 30 to "30 天", 0 to "永不")
    options.forEach { (value, label) ->
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .selectable(selected = current == value, onClick = { onPick(value) })
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = current == value, onClick = { onPick(value) })
            Spacer(Modifier.width(8.dp))
            Text(label, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
