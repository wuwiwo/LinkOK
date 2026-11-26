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
enum class Screen { WELCOME, STASH, SETTINGS, SCAN, LOGS }

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

    // 是否已经过了欢迎页。
    // 用一次性的本地状态而不是持久化偏好：欢迎页每次都该出现（用户可能
    // 清过数据或换了手机），但同一次运行内看过了就不再重复。
    var onboarded by remember { mutableStateOf(false) }

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

    // 重新配对时记录进入扫码页那一刻的 token。
    // 只有 token 真的**变了**（拿到了新令牌）才收工回到首页；
    // 否则 DataStore 的重复发射会把用户从扫码页弹走，表现就是一闪而过。
    var tokenBeforeRepair by remember { mutableStateOf<String?>(null) }

    // 配对成功（拿到了不同的 token）→ 回到首页并复位 repairing。
    LaunchedEffect(config.token) {
        if (!repairing) return@LaunchedEffect
        val current = config.token
        val before = tokenBeforeRepair
        // before == null 表示这是首次配对（原本没有 token），任何非空都应触发。
        val gotNewToken = current.isNotBlank() && current != before
        if (gotNewToken) {
            repairing = false
            tokenBeforeRepair = null
            screen = Screen.STASH
        }
    }

    // 首屏决策。
    //
    // 早先写成「未配对 → 强制 SCAN」，结果是：首次安装、清过数据、或换机后
    // 一打开 App 就直接怼到扫码页，没有品牌页也没有说明，像是被强行塞进流程。
    //
    // 现在多一个 WELCOME 中转页：
    //   - 尚未配对 → WELCOME（介绍 + 两个按钮：开始配对 / 稍后再说）
    //   - 已配对   → STASH
    //   - 用户主动点了「重新配对」或走深链 → SCAN（跳过 WELCOME）
    val effective = when {
        repairing -> Screen.SCAN
        config.token.isBlank() && !onboarded -> Screen.WELCOME
        config.token.isBlank() -> Screen.SCAN
        screen == null -> Screen.STASH
        else -> screen!!
    }

    // 系统返回键的语义：
    //   设置页 → 回首页
    //   配对页（用户主动进来的）→ 回首页
    //   首页 → 交给系统处理（退出）
    // 之前没有这段，系统返回在任意页面都会直接退出 App，
    // 用户反馈"按返回是返回至首页而不是关掉"说的就是这个。
    androidx.activity.compose.BackHandler(enabled = effective == Screen.SETTINGS || effective == Screen.SCAN || effective == Screen.LOGS) {
        repairing = false
        // 扫码页返回时看配对状态：未配对回欢迎页，已配对回首页。
        // 设置页一律回首页。
        screen = when {
            effective == Screen.SCAN && config.token.isBlank() -> Screen.WELCOME
            effective == Screen.LOGS -> Screen.SETTINGS
            else -> Screen.STASH
        }
    }

    when (effective) {
        Screen.WELCOME -> WelcomeScreen(
            onStartPairing = {
                onboarded = true
                screen = Screen.SCAN
            },
            onSkip = {
                // 「稍后再说」也直接去扫码页 —— 不配对 App 没有可用功能，
                // 但至少用户是自己走进去的，不是被强塞。
                onboarded = true
                screen = Screen.SCAN
            },
        )
        Screen.STASH -> StashScreen(
            vm = vm,
            onOpenSettings = { screen = Screen.SETTINGS },
            onOpenAccessibility = onOpenAccessibility,
        )
        Screen.SETTINGS -> SettingsScreen(
            vm = vm,
            onOpenLogs = { screen = Screen.LOGS },
            onBack = {
                // 左上角箭头 = "回上一页"，即首页。
                screen = Screen.STASH
            },
            onRepair = {
                tokenBeforeRepair = config.token
                repairing = true
                screen = Screen.SCAN
            },
            onOpenAccessibility = onOpenAccessibility,
        )
        Screen.LOGS -> LogScreen(
            onBack = { screen = Screen.SETTINGS },
        )
        Screen.SCAN -> PairingScreen(
            vm = vm,
            // 返回按钮的显示条件。
            //
            // 早先写的是 `token 非空 && !repairing` —— 也就是"只有已配对的人
            // 才能返回"。但未配对的人从欢迎页走进来时同样需要有退路，
            // 否则他被困在相机页：没有返回箭头，系统返回键又直接退出 App。
            // 现在只要能回到欢迎页或首页，就显示返回。
            canSkip = true,
            onDone = {
                repairing = false
                tokenBeforeRepair = null
                screen = Screen.STASH
            },
            onCancel = {
                repairing = false
                tokenBeforeRepair = null
                // 未配对时退回欢迎页，已配对时退回首页。
                screen = if (config.token.isBlank()) Screen.WELCOME else Screen.STASH
            },
            onRequestPermissions = onRequestPermissions,
        )
    }
}

