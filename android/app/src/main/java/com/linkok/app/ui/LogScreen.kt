package com.linkok.app.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.linkok.app.core.AppLog

/**
 * 日志查看页。
 *
 * 为什么要内置这一页：手机端的日志如果只能靠 `adb logcat` 看，等于没有 ——
 * MIUI 会屏蔽 logcat（实测经常是空的），用户拿不到任何线索。
 * 现在日志写在 App 私有目录里，用户可以直接在这里看、导出、分享。
 *
 * 只读最近 800 行：全量渲染几 MB 文本会让 Compose 卡死，
 * 而调试时看最新的才有意义。要看全部就用「导出」。
 */
@Composable
fun LogScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var lines by remember { mutableStateOf<List<String>>(emptyList()) }
    var stats by remember { mutableStateOf("") }
    var levelLabel by remember { mutableStateOf("") }

    fun reload() {
        AppLog.flush()
        val files = AppLog.files()
        val all = files.reversed().flatMap { f ->
            runCatching { f.readLines() }.getOrDefault(emptyList())
        }
        lines = all.takeLast(800)
        stats = "${files.size} 个文件 · ${AppLog.totalBytes() / 1024} KB"
        levelLabel = if (AppLog.isDebugEnabled()) "详细（DEBUG）" else "常规（INFO）"
    }

    LaunchedEffect(Unit) { reload() }

    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding(),
        ) {
            // 顶栏
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "返回",
                    )
                }
                Column(Modifier.weight(1f)) {
                    Text("运行日志", style = MaterialTheme.typography.titleLarge)
                    Text(
                        text = "$stats · 级别 $levelLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = { reload() }) { Text("刷新") }
            }

            // 操作行
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = {
                        AppLog.flush()
                        val text = AppLog.exportText()
                        val intent = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, "LinkOK 运行日志")
                            putExtra(Intent.EXTRA_TEXT, text)
                        }
                        runCatching {
                            context.startActivity(
                                Intent.createChooser(intent, "导出日志")
                            )
                        }
                    },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(50),
                ) { Text("导出 / 分享") }

                TextButton(
                    onClick = {
                        AppLog.setDebugEnabled(!AppLog.isDebugEnabled())
                        reload()
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(if (AppLog.isDebugEnabled()) "关闭详细" else "开启详细")
                }
            }

            Spacer(Modifier.height(8.dp))

            if (lines.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "还没有日志",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 12.dp, end = 12.dp, bottom = 16.dp
                    ),
                ) {
                    items(lines) { line ->
                        Text(
                            text = line,
                            // 等宽字体让多行堆栈和缩进对齐。
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            lineHeight = 14.sp,
                            color = when {
                                // ERROR 用错误色，WARN 用 tertiary，其余保持中性。
                                line.contains(" E ") -> MaterialTheme.colorScheme.error
                                line.contains(" W ") -> MaterialTheme.colorScheme.tertiary
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            modifier = Modifier.padding(vertical = 1.dp),
                        )
                    }
                }
            }
        }
    }
}
