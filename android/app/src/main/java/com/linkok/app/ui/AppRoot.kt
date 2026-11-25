package com.linkok.app.ui

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * 应用根：按配对状态决定进入配对引导还是主界面。
 * 设置页与扫码页用简单的本地状态切换，不引入导航库（只有三屏，不值得）。
 */
enum class Screen { STASH, SETTINGS, SCAN }

@Composable
fun AppRoot(
    vm: LinkViewModel,
    onRequestPermissions: () -> Unit,
    onOpenAccessibility: () -> Unit,
    /** 深链带进来的 `linkok://pair?...`，进入后立即尝试配对。 */
    pendingPayload: String? = null,
) {
    val config by vm.config.collectAsStateWithLifecycle()
    var screen by remember { mutableStateOf<Screen?>(null) }

    // 用户主动点了「重新配对」。
    // 这时候即使本地还存着 token，也必须停在扫码页 —— 否则 PairingScreen 里
    // 那个 `LaunchedEffect(token) { if (token 非空) onDone() }` 会在进入的瞬间
    // 把人弹回首页，表现就是"点重新配对没反应"。这是之前的真实 bug。
    var repairing by remember { mutableStateOf(false) }

    // 深链配对。
    // 关键：singleTask 下第二次点链接走 onNewIntent，App 已经在组合里了，
    // 所以不能用一个"消费过就不再处理"的布尔量 —— 必须按 payload 本身去重。
    // 早先写成 `if (!consumed)` 的版本，导致冷启动之后的深链全部被吞掉。
    var handledPayload by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(pendingPayload) {
        val payload = pendingPayload
        if (!payload.isNullOrBlank() && payload != handledPayload) {
            handledPayload = payload
            repairing = true
            vm.pairFromQr(payload)
        }
    }

    // 配对成功（token 从空变为非空，或重新配对拿到了新 token）→ 回到首页并复位 repairing。
    LaunchedEffect(config.token) {
        if (config.token.isNotBlank() && repairing) {
            repairing = false
            screen = Screen.STASH
        }
    }

    // 未配对时强制进入配对引导；已配对时听用户的选择。
    val effective = when {
        config.token.isBlank() -> Screen.SCAN
        repairing -> Screen.SCAN
        screen == null -> Screen.STASH
        else -> screen!!
    }

    // 系统返回键的语义：
    //   设置页 → 回首页
    //   配对页（用户主动进来的）→ 回首页
    //   首页 → 交给系统处理（退出）
    // 之前没有这段，系统返回在任意页面都会直接退出 App，
    // 用户反馈"按返回是返回至首页而不是关掉"说的就是这个。
    androidx.activity.compose.BackHandler(enabled = effective != Screen.STASH) {
        repairing = false
        screen = Screen.STASH
    }

    when (effective) {
        Screen.STASH -> StashScreen(
            vm = vm,
            onOpenSettings = { screen = Screen.SETTINGS },
            onOpenAccessibility = onOpenAccessibility,
        )
        Screen.SETTINGS -> SettingsScreen(
            vm = vm,
            onBack = {
                // 左上角箭头 = "回上一页"，即首页。
                screen = Screen.STASH
            },
            onRepair = {
                repairing = true
                screen = Screen.SCAN
            },
            onOpenAccessibility = onOpenAccessibility,
        )
        Screen.SCAN -> PairingScreen(
            vm = vm,
            canSkip = config.token.isNotBlank() && !repairing,
            onDone = {
                repairing = false
                screen = Screen.STASH
            },
            onCancel = {
                repairing = false
                screen = Screen.STASH
            },
            onRequestPermissions = onRequestPermissions,
        )
    }
}

