package com.linkok.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * 版本页脚。
 *
 * 三处显示版本（欢迎页、配对页、设置页）必须长一样，所以抽出来。
 *
 * 规格（按用户要求）：字号最小、灰色、贴着底部但留一点呼吸空间。
 *   - labelSmall（11sp）
 *   - onSurfaceVariant 再降到 40% 不透明度 —— 它是诊断信息，不该抢注意力
 *   - 只显示语义版本 + 构建时间，不显示内部 versionCode
 */
@Composable
fun VersionFooter(
    modifier: Modifier = Modifier,
    showBuildTime: Boolean = true,
) {
    val text = if (showBuildTime) {
        "开发版 ${com.linkok.app.BuildConfig.VERSION_NAME}"
    } else {
        "开发版 ${com.linkok.app.BuildConfig.VERSION_NAME}"
    }
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
        textAlign = TextAlign.Center,
        modifier = modifier.padding(bottom = 12.dp),
    )
}
