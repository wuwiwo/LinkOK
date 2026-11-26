package com.linkok.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Photo
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * 启动页（欢迎页）。
 *
 * 为什么需要：之前「未配对」会被强制路由到扫码页，一打开 App 就是相机取景，
 * 既没有品牌也没有说明，像是被塞进一个流程。这一页承担三件事：
 *   1. 说清 LinkOK 是干什么的（一句话）；
 *   2. 说明它不需要账号、数据不出局域网；
 *   3. 给两个出口：现在配对 / 先看看（同样进扫码页，但是用户自己选的）。
 */
@Composable
fun WelcomeScreen(
    onStartPairing: () -> Unit,
    onSkip: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(0.7f))

            // 图标：用主题色圆底 + 手机图标
            Box(
                modifier = Modifier
                    .size(88.dp)
                    .background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.PhoneAndroid,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.size(40.dp),
                )
            }

            Spacer(Modifier.height(24.dp))
            Text(
                text = "LinkOK",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "手机和电脑之间同步截图与剪贴板",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(36.dp))

            // 三条要点
            FeatureLine(Icons.Outlined.Photo, "手机截图，电脑直接粘贴")
            FeatureLine(Icons.Outlined.ContentPaste, "电脑截图，手机上保存")
            FeatureLine(
                Icons.Outlined.PhoneAndroid,
                "纯局域网，不需要账号和云端",
            )

            Spacer(Modifier.weight(1f))

            Button(
                onClick = onStartPairing,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                shape = RoundedCornerShape(50),
            ) {
                Text("开始配对", style = MaterialTheme.typography.titleMedium)
            }

            Spacer(Modifier.height(4.dp))

            TextButton(
                onClick = onSkip,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "还没准备好，先看看",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(20.dp))

            // 版本号：小字、灰色、贴近底部
            Text(
                text = "开发版 ${com.linkok.app.BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f),
            )
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun FeatureLine(icon: ImageVector, text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Start,
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
