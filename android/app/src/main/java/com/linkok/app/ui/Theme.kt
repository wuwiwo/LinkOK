package com.linkok.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import android.os.Build

/**
 * Material 3 主题。
 *
 * 规则见 SPEC §6.1：
 * - Android 12+ 用动态取色；低版本回退到固定的品牌色。
 * - 不引入语义化的绿/黄/红 —— M3 没有 success 角色。
 * - 状态永不只靠颜色传达，圆点旁必须有文字。
 */
@Composable
fun LinkOKTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> FallbackDarkColors
        else -> FallbackLightColors
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}

/** 低版本回退色板：一种克制的深绿，接近 App 图标底色。 */
private val FallbackLightColors = lightColorScheme(
    primary = Color(0xFF1B6C4B),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFA6F2C8),
    onPrimaryContainer = Color(0xFF002114),
    secondary = Color(0xFF4E6355),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD0E8D6),
    onSecondaryContainer = Color(0xFF0B1F14),
    tertiary = Color(0xFF3B6470),
    onTertiary = Color(0xFFFFFFFF),
    background = Color(0xFFFBFDF8),
    onBackground = Color(0xFF191C1A),
    surface = Color(0xFFFBFDF8),
    onSurface = Color(0xFF191C1A),
    surfaceVariant = Color(0xFFDCE5DC),
    onSurfaceVariant = Color(0xFF404943),
    outline = Color(0xFF707973),
    outlineVariant = Color(0xFFC0C9C1),
)

private val FallbackDarkColors = darkColorScheme(
    primary = Color(0xFF8BD5AA),
    onPrimary = Color(0xFF003825),
    primaryContainer = Color(0xFF005236),
    onPrimaryContainer = Color(0xFFA6F2C8),
    secondary = Color(0xFFB4CCB9),
    onSecondary = Color(0xFF203528),
    secondaryContainer = Color(0xFF364B3E),
    onSecondaryContainer = Color(0xFFD0E8D6),
    tertiary = Color(0xFFA2CDD9),
    onTertiary = Color(0xFF00363F),
    background = Color(0xFF191C1A),
    onBackground = Color(0xFFE1E3DF),
    surface = Color(0xFF191C1A),
    onSurface = Color(0xFFE1E3DF),
    surfaceVariant = Color(0xFF404943),
    onSurfaceVariant = Color(0xFFC0C9C1),
    outline = Color(0xFF8A938C),
    outlineVariant = Color(0xFF404943),
)
