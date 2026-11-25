# Changelog

本文件的格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

手机端 APK 的版本号带构建时间（如 `0.2-1125-2214`），
可在 App 的**配对页底部**或**设置页底部**看到，用来确认装的是哪一次构建。

---

## [0.2.2] — 2026-11-25

### 修复

**「换个配对码」点了不换**

上一版只是从日志里重读**已经存在**的那条链接，从未请求 Hub 生成新码，所以链接当然不变。
现在真正调用 `POST /api/pairing-code`（用 `device.json` 里的 Token），
生成并复制一个全新的码；失败时才退回日志里的旧链接，并明确告知。

**手机输入配对链接「没反应也没提示」**

`LinkViewModel` 把错误写进 `_message`，靠 Snackbar 显示，而 **`PairingScreen` 里没有
`SnackbarHost`** —— 于是「无效的二维码」「配对失败」这些话全被静默丢弃。
用户看到的就是点了没反应。现在双保险：Snackbar + 页面内常驻的错误条（Snackbar 会消失，错误条不会）。

**手打配对链接几乎不可能成功**

输入法会吞掉 `://`、`?`、`&`、`=`（实测 `linkok://pair?...` 变成 `inklokpairhost96885`）。
新增**「从剪贴板粘贴」**按钮：电脑窗口点「换个配对码」会把链接放进剪贴板，
手机上点这个按钮一键读入，完全不经过键盘。

---

## [0.2.1] — 2026-11-25

### 修复

**已配对时，窗口里的二维码是空白白框**

Hub 已配对时 `banner()` 不打印配对链接，导致 Launcher 的 `_currentPayload` 恒为空：
二维码区只剩一个白框，「复制配对链接」复制不到任何东西，「换个配对码」也换不出新码。
手机一旦丢失 token（重装、清数据、换机），**在界面上就再也无法重新配对** ——
唯一的出路是手动删掉 `device.json` 再重启，普通用户不可能想到。

修复分两处：
- Hub 已配对时也在日志里写一条**备用配对码**（标注 `spare, for a re-pairing`），
  不进控制台横幅，避免让人误以为还要重扫
- Launcher 的「换个配对码」改为从日志读取最新载荷并显示、复制；
  「复制配对链接」在无当前码时也会先尝试取备用码，而不是静默 return

**空二维码框会被误读成加载失败**

已配对时不再清空图片留下白框，改为渲染一个对勾状态图，并把提示文字改成
「已配对 · 手机打开 LinkOK 即可连接」。

---

## [Unreleased]

### 计划中

- Windows 原生 Toast 通知（目前依赖托盘气泡，托盘不可用时通知失效）
- 电脑端设置页的剪贴板历史视图（`GET /api/clipboard` 已就绪，前端未接）
- 多显示器 / DPI 变化时的托盘图标重绘

---

## [0.2] — 2026-11-25

这一版修的是“功能看起来在跑、实际没通”的一批问题。全部来自真机实测发现。

### 修复

**手机收不到电脑截图（最严重）**

手机端 `finishCapture()` 收到图后**从不发送 `capture-result`**。而 Hub 的 PC Capture 是严格
串行投递的——它等这条 ACK 或 10 秒超时才发下一张。所以每张图都卡满 10 秒，用户看到的现象
就是“手机没收到”，Hub 日志是 `no capture-result for … after 10s; moving on`。

顺带修了一个相邻缺陷：`bytes` 字段解析失败时会退化为 0，导致第一帧就被当作完整图收下，
半张图哈希不符被丢弃，Stash 里空无一物。现在只在 `received == expected` 时收尾，并显式处理溢出。

**手机显示「未连接」但其实是连着的**

`LinkViewModel` 只在 `refresh()` 时取一次连接状态快照，而那次快照发生在 Link 建立之前。
配对成功后 UI 永远停在“未连接”。改为持续跟踪（每 1 秒），连上时顺便刷新 Stash。

**Android 拦截明文 HTTP，配对必然失败**

Android 9+ 默认禁止明文 HTTP，而 LinkOK 的前提就是局域网 `http://192.168.x.x:8787`。
缺少 `network_security_config` 时所有请求抛
`UnknownServiceException: CLEARTEXT communication not permitted`，即使密码正确也配不上。
已加入配置并允许明文（理由和风险边界写在 `network_security_config.xml` 的注释里）。

**截图被 Hub 拒绝（`not a PNG`）**

手机截图默认是 **JPG**（小米实测），而协议要求 PNG。原先直接把 JPG 字节打上 `image/png`
标签发出去，Hub 校验魔数失败拒绝。现在手机端真实转码为 PNG，且哈希改用**转码后**的内容
（Hub 校验的是实际收到的字节）。Hub 侧也新增 `sniffImageFormat`，拒绝时直接说明对方发的是什么格式。

**双击 `LinkOK.exe` 没有界面**

最初给的是控制台程序。已重写为 WinForms 窗口：二维码、配对码、可复制链接、实时日志、三个按钮，
关掉窗口缩到托盘继续运行。

**双击 `start.cmd` 没反应**

文件是 UTF-8，但 `cmd.exe` 按 GBK 读取，中文注释被打乱成命令（`'需要，运行' is not recognized`）。
已改为纯 ASCII 并 `chcp 65001`。

**「扫码配对」按钮不会扫码**

按钮只切换出一个文本框，zxing 依赖写在 `build.gradle.kts` 里却从未被调用。已接入 `ScanContract`。

**点「重新配对」被立刻弹回首页**

`AppRoot` 的 `effective` 优先判断 `token.isBlank()`，而 `PairingScreen` 又有
`LaunchedEffect(token) { if (token 非空) onDone() }`。刚进扫码页就被弹走。已加 `repairing` 标志。

**配对失效后无法恢复**

手机收到 401 时只会无限重试，表现是永远“未连接”，且“重新配对”似乎没反应
（旧的失败循环在后台打断新尝试）。现在 401 立即停止重连、清除本地 token、自动回到扫码页。

**同一个配对链接失效**

配对码有效期 120 秒，超时是安全设计。但界面上没有提示，用户以为是 bug。现在窗口里有
「换个配对码」按钮，并明确说明有效期。

**两个 `LinkOK.exe` 抢端口**

第二个实例启动失败并显示「已停止（代码 2）」，用户不知道是“已经有一个在跑”。
已加单实例互斥体，第二个会明确提示。端口被占用时也会给出 `taskkill` 命令和换端口方案。

**Hub 启动时二维码窗口弹不出来**

`banner()` 在 helper 还没 ready 时就调用 `showQr`，请求被丢弃。现在记住待显示的 payload，
helper ready 后补弹。

**配对指纹在所有机器上相同**

未配对时 `fingerprintOf('')` 返回空字符串的 SHA-256，**每台机器都一样**，
UDP 发现会认错 Hub。改用持久化的 `instanceId`（并在配对、吊销时保留）。

**helper 在发出 `ready` 前就退出**

临时目录硬回退到 `%TEMP%\LinkOK`，不可写时抛 `UnauthorizedAccessException`。
Hub 只能看到 `exited unexpectedly (4294967295)` 无限重启。现在按
`LINKOK_HELPER_TMP` → `<dataDir>\tmp` → `%LOCALAPPDATA%\LinkOK\tmp` → `%TEMP%\LinkOK`
依次探测（真实写测试），全失败时抛出**带指引的**异常。Hub 也改为降级到慢速重试而非永久放弃。

**配对链接无法从外部获取**

GUI 版没有控制台，配对链接只存在于窗口文本框里。现在同时写入日志文件，便于排查和脚本化。

### 新增

- **首页显示最近一次剪贴板同步**：方向、文本预览、字符数，可关闭。剪贴板同步原本完全透明，
  用户无法确认“刚才那段文字到底同步过去没有”。
- **`GET /api/clipboard`**：Hub 端记录最近 50 条剪贴板同步（只留预览，不留全文——剪贴板可能是密码）。
- **首页无障碍提醒条**：无障碍未开启时提示“手机复制的内容还不会同步到电脑”，可跳转设置、可关闭。
  无障碍是「手机复制 → 电脑」的唯一路径，没开时那条链路是断的，但之前首页毫无提示。
- **`linkok://pair?...` 深链**：可以直接点开链接配对，不用手敲 74 个字符。
- **系统返回键处理**：设置页/配对页返回到首页，首页才退出 App。
- **`GET /api/state` 的 `delivery` 诊断字段**：`queued` / `awaitingResultId` / `awaitingSinceMs`，
  下次“手机没收到”时能一眼看出卡在「没发出」「发了没回执」还是「回执了但落盘失败」。
- **版本号纪律**：`versionCode` 每次构建自动递增，`versionName` 形如 `0.2-1125-2214`，
  配对页和设置页都显示版本与构建时间。

### 变更

- PC 原生桥改用 **C# / .NET Framework 4.8**，用 Windows 自带的 `csc.exe` 编译，
  不需要 .NET SDK。决策与代价见 [ADR 0004](docs/adr/0004-csharp-helper-on-net-framework.md)。
- Hub 的 PC Capture 队列移到 `Hub.pendingOutbound`，断线期间产生的截图会在重连后按序重放，
  不再随 Link 对象一起丢失。
- `scripts/env.ps1` 不再硬编码工具链绝对路径，改为按
  `LINKOK_TOOLCHAIN` → `.toolchain/` → `~/.linkok-toolchain` 自动探测；
  `adb` 同样改为自动查找。找不到工具链时只警告，不影响只跑 Hub。

### 已知问题

- **Windows 通知依赖托盘图标**。非交互桌面会话下 `Shell_NotifyIcon` 失败（win32=5），
  通知随之失效。剪贴板与截图监听不受影响。
- **深链在部分 MIUI 版本上被后台启动限制拦截**。手动点击链接正常，`adb am start` 可能被拒。
- **`adb shell input text` 无法输入 URL**：会吞掉 `://?&=` 并把字符顺序打乱
  （实测 `linkok://pair?...` 变成 `inklokpairhost96885`）。这是 adb 的机制限制，
  所以**配对请用扫码或深链**，不要手打。

---

## [0.1.0] — 2026-11-25

首个可运行版本。

### 新增

- 电脑端 Node Hub：HTTP + WebSocket（手写 RFC 6455）、二维码配对、长期 Token、
  JSON 索引历史、保留期清理、Echo 抑制、断线重放
- 电脑端 C# 原生桥：剪贴板图片/文本监听、截图目录监听、托盘、二维码窗口、Windows 通知
- 电脑端设置页：零依赖静态单页，Material 3，四分区（概览/历史/设备/设置）
- 手机端：Kotlin + Compose + Material 3，前台服务、Stash（保存/丢弃/批量）、
  无障碍剪贴板同步、快捷设置磁贴、开机自启
- 文档：[SPEC](docs/SPEC.md)、[PROTOCOL](docs/PROTOCOL.md)、[术语表](CONTEXT.md)、
  4 份 [ADR](docs/adr/)

### 验证

- Hub：186 项单元测试通过
- APK：构建 → 安装 → 启动 → 渲染，真机零崩溃
- 端到端：电脑剪贴板图片 → C# 解码 → 落盘 → 索引 → 可回取；
  手机 JPEG 截图 → 转码 PNG → WS 上行 → Hub 接受
