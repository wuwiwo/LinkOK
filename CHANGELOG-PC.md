# Changelog — 电脑端

本文件只记录**电脑端**的变更：Node Hub、C# 原生桥（`pc/helper`）、设置页（`pc/public`）。

- 手机 App 的变更见 [CHANGELOG-ANDROID.md](CHANGELOG-ANDROID.md)
- 两端的版本号**独立演进**，各自在 `version.config` / `android/version.config`
- 发版用 `scripts/release-pc.ps1 -Minor|-Patch "标题"`

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

（下次发版的内容先写在这里）

---


## [0.3.2] — 2026-11-26

### 变更

**独立版本号**

电脑端有了自己的 `version.config`，与手机 App 的版本解耦。
之前两端共用一个号，任何一端改动都会让另一端"看起来也升级了"，
无法判断实际部署的是哪一端的哪个版本。

---

## [0.3.0] — 2026-11-26

### 新增

**`GET /api/clipboard` 与剪贴板同步记录**

Hub 端记录最近 50 条剪贴板同步（只留 500 字符预览，不留全文——剪贴板可能是密码）。
剪贴板同步原本完全透明，用户无法确认"刚才那段文字到底同步过去没有"。

**`GET /api/state` 的 `delivery` 诊断字段**

`queued` / `awaitingResultId` / `awaitingSinceMs`。
下次"手机没收到"时能一眼看出卡在「没发出」「发了没回执」还是「回执了但落盘失败」。

### 修复

**已配对时，窗口里的二维码是空白白框**

`banner()` 只在未配对时生成配对链接，导致 GUI 的 `_currentPayload` 恒为空：
二维码区只剩白框，「复制配对链接」复制不到东西，「换个配对码」换不出新码。
手机一旦丢失 token（重装、清数据、换机），界面上就再也无法重新配对。

现在已配对时也在日志写一条**备用配对码**（标注 `spare, for a re-pairing`），
不进控制台横幅以免误以为要重扫。

**「换个配对码」点了不换**

上一版只是从日志重读已存在的链接，从未请求 Hub 生成新码。
现在真正调用 `POST /api/pairing-code`，生成并复制全新码；
失败时才退回旧链接并明确告知。

**配对失败时界面无任何提示**

`LinkViewModel` 把错误写进 `_message` 靠 Snackbar 显示，而配对页没有
`SnackbarHost`，所有错误被静默丢弃。

### 变更

**`scripts/env.ps1` 不再硬编码工具链路径**

改为按 `LINKOK_TOOLCHAIN` → `.toolchain/` → `~/.linkok-toolchain` 自动探测；
`adb` 同样自动查找。找不到工具链时只警告，不影响只跑 Hub。

同时修了 `Invoke-Gradle` 的作用域 bug：函数体内裸写 `$Gradle` 会解析成空字符串，
报"无法绑定到 FilePath"。

---

## [0.2.3] — 2026-11-26

### 修复

**日志一天涨到 5.3 GB，吃掉磁盘**

手机 token 失效后按退避策略不停重连，每次都 401，Hub 每笔都写一行 WARN。
实测日志文件涨到 5.3 GB，磁盘被吃掉、GUI 读日志卡死、真正有价值的错误全被埋掉。

两层防护：
- **握手拒绝节流**：同一来源每 60 秒只记一条，其余计数后一次性汇报
  （实测 200 次拒绝只写 1 行日志）
- **日志文件轮转**：单文件上限 50 MB，超过切分片；同一天最多保留 5 个，
  更早的自动删除。启动时若发现已有文件超限，立刻轮转而不是继续追加

**连接在等 ACK 期间断开，那张截图永久丢失**

Hub 的 PC Capture 严格串行投递，等 `capture-result` 或 10 秒超时。
但如果连接在这个窗口内断掉，`_onClose` 只是清掉 `awaitingResult`——
那张图既没有 `delivered`（不会从待重放队列移除），也没有重新入队，
重连后**永远不会补发**。

现在把它塞回队列头部优先重发，并把 Link 内部队列里剩余的图一并回收：

```
capture …-0001 was in flight when the Link dropped; re-queued for the next connection
recovered 1 undelivered capture(s) for replay on reconnect
```

---

## [0.2.2] — 2026-11-25

### 修复

**配对指纹在所有机器上相同**

未配对时 `fingerprintOf('')` 返回空字符串的 SHA-256，**每台机器都一样**，
UDP 发现会认错 Hub。改用持久化的 `instanceId`（在配对、吊销时保留）。

**helper 在发出 `ready` 前就退出**

临时目录硬回退到 `%TEMP%\LinkOK`，不可写时抛 `UnauthorizedAccessException`。
Hub 只能看到 `exited unexpectedly (4294967295)` 无限重启。
现在按 `LINKOK_HELPER_TMP` → `<dataDir>\tmp` → `%LOCALAPPDATA%\LinkOK\tmp`
→ `%TEMP%\LinkOK` 依次探测（真实写测试），全失败时抛出**带指引的**异常。
Hub 也改为降级到慢速重试而非永久放弃。

**配对链接无法从外部获取**

GUI 版没有控制台，配对链接只存在于窗口文本框里。现在同时写入日志文件。

---

## [0.2] — 2026-11-25

### 修复

**手机收不到电脑截图（ACK 缺失）**

手机端 `finishCapture()` 收到图后**从不发送 `capture-result`**。而 Hub 的
PC Capture 是严格串行投递的——它等这条 ACK 或 10 秒超时才发下一张。
所以每张图都卡满 10 秒，用户看到的现象就是"手机没收到"，
Hub 日志是 `no capture-result for … after 10s; moving on`。

顺带修了一个相邻缺陷：`bytes` 字段解析失败时会退化为 0，导致第一帧就被当作
完整图收下，半张图哈希不符被丢弃，Stash 里空无一物。

**手机显示未连接但其实是连着的**

连接状态快照只在初始化时取一次，而那次快照发生在 Link 建立之前。

**两个 `LinkOK.exe` 抢端口**

第二个实例启动失败并显示「已停止（代码 2）」，用户不知道是"已经有一个在跑"。
已加单实例互斥体，端口被占用时给出 `taskkill` 命令和换端口方案。

**Hub 启动时二维码窗口弹不出来**

`banner()` 在 helper 还没 ready 时就调用 `showQr`，请求被丢弃。
现在记住待显示的 payload，helper ready 后补弹。

**双击 `start.cmd` 没反应**

文件是 UTF-8，但 `cmd.exe` 按 GBK 读取，中文注释被打乱成命令。改为纯 ASCII。

### 变更

- PC 原生桥改用 **C# / .NET Framework 4.8**，用 Windows 自带的 `csc.exe` 编译，
  不需要 .NET SDK。决策与代价见 [ADR 0004](docs/adr/0004-csharp-helper-on-net-framework.md)
- Hub 的 PC Capture 队列移到 `Hub.pendingOutbound`，断线期间产生的截图会在重连后
  按序重放，不再随 Link 对象一起丢失

---

## [0.1.0] — 2026-11-25

首个可运行版本。

### 新增

- Node Hub：HTTP + WebSocket（手写 RFC 6455）、二维码配对、长期 Token、
  JSON 索引历史、保留期清理、Echo 抑制、断线重放
- C# 原生桥：剪贴板图片/文本监听、截图目录监听、托盘、二维码窗口、Windows 通知
- 设置页：零依赖静态单页，Material 3，四分区（概览/历史/设备/设置）
- 文档：[SPEC](docs/SPEC.md)、[PROTOCOL](docs/PROTOCOL.md)、[CONTEXT](CONTEXT.md)、
  4 份 [ADR](docs/adr/)

### 验证

- 186 项单元测试通过
- 端到端：电脑剪贴板图片 → C# 解码 → 落盘 → 索引 → 可回取
