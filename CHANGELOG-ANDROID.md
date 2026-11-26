# Changelog — 手机 App

本文件只记录**手机端**的变更：Kotlin + Jetpack Compose + Material 3。

- 电脑端的变更见 [CHANGELOG-PC.md](CHANGELOG-PC.md)
- 两端的版本号**独立演进**，各自在 `android/version.config` / `version.config`
- 发版用 `scripts/release-android.ps1 -Minor|-Patch "标题"`

APK 的版本串形如 `0.3.2-1126-1030`（语义版本 + 构建时间），
可在 App 的**欢迎页/配对页/设置页底部**看到，用来确认装的是哪一次构建。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

（下次发版的内容先写在这里）

---


## [0.3.2] — 2026-11-26

### 变更

**独立版本号**

手机端有了自己的 `android/version.config`，与电脑端解耦。

### 修复

**前台服务从未被启动 —— 手机永远连不上电脑**

`MainActivity.onCreate` 里写 `if (vm.isPaired) vm.startService()`，而
`isPaired` 读的是 `_config.value.token`；`_config` 在 ViewModel 的 init
协程里异步加载，onCreate 这一刻还是空值。条件永远不成立，`LinkService`
从未启动，手机因此不会主动连接电脑。

现象：首页一直显示「电脑未连接」，但两边 token 其实完全一致，
排查时极易误判成配对失效。

现在订阅 config 流，读到 token 就启动服务（标志位防重复）。

**点「重新配对」一闪而过**

`PairingScreen` 里 `LaunchedEffect(token) { if (非空) onDone() }` 在进入页面
的瞬间就触发 —— 重新配对时本地本来就存着旧 token，于是刚进去就被弹回首页。

现在记录进入时的 token，只有 token **变成不同的值**才自动离开；
`AppRoot` 同步记录 `tokenBeforeRepair`，避免 DataStore 重复发射造成误判。

### 验证

修复后实测：手机连上（`hello from Xiaomi M2012K11AC`），
电脑截图 180237 字节 → 手机 Stash 落盘 180237 字节，完全一致。

---

## [0.3.1] — 2026-11-26

### 修复

**扫码页无法返回**

`canSkip` 要求「已配对」，未配对的人从欢迎页走进扫码页后被困住：
没有返回箭头，系统返回键又直接退出 App。

现在始终显示左上角圆形返回按钮；返回目标按配对状态决定
（未配对回欢迎页，已配对回首页）。系统返回键也改成同样语义。

**标题顶到状态栏**

缺少 `statusBarsPadding`，大标题被时间/信号那一行压住，
底部版本号也会被手势条盖住。现在两处都加了 insets 处理。

---

## [0.3.0] — 2026-11-26

### 新增

**启动页（欢迎页）**

之前「未配对」会被强制路由到扫码页 —— App 一打开就是相机取景，既没有品牌
也没有说明，像是被塞进一个流程。现在多一个中转页：图标 + 名称 + 一句话介绍
+ 三条要点（手机截图电脑粘贴 / 电脑截图手机保存 / 纯局域网无账号）
+ 两个出口（开始配对 / 还没准备好）。

**版本号单一来源**

`0.MINOR.PATCH`：MINOR = 功能变更或重大修复，PATCH = 小修复。
`scripts/release-*.ps1` 一条命令同步版本文件、`pc/package.json`、
`CHANGELOG-*.md`，并提交推送。Android 的 `versionCode` 仍由
`android/version.properties` 单调递增（覆盖安装需要），两者互不干扰。

### 变更

**配对页改成页内取景（参考常见的桌面远控 App）**

原来点「扫码配对」会弹出 zxing 的全屏 Activity，和 App 的视觉语言脱节，
而且无法在同一页里同时给出「粘贴链接」这条降级路径。现在：

- 预览交给 **CameraX**，解码仍用 zxing 的 `core`（不引入 embedded 封装层）
- 版式：大标题 + 一行说明 + 圆角取景框（四角标记）+「从相册识别」+「粘贴配对链接」
- 相机权限被拒时，取景框内直接给出「授予相机权限」按钮，不再空白
- 解码在独立线程、单帧串行（`AtomicBoolean` 闸门），不会拖慢预览
- 直接解 Y plane 亮度，不做 YUV→RGB 转换，省一次全图拷贝
- 相册识别：大图先按 1600px 采样，失败时自动尝试 90/180/270 旋转

**版本文字规格统一**

三处（欢迎页 / 配对页 / 设置页）抽成 `VersionFooter` 组件：
`labelSmall` 字号、`onSurfaceVariant` 降到 45% 不透明度、贴近底部。

### 修复

**一启动就连弹两次权限**

`MainActivity.onCreate` 无条件请求相机和相册，用户在欢迎页还没看清这是什么 App，
就先被问「是否允许拍摄照片」「是否允许访问照片和视频」。

现在：相机权限由扫码页进入时按需申请；相册走系统选择器
（`ActivityResultContracts.GetContent`），它自己会授权单张图，
根本不需要 `READ_MEDIA_IMAGES`。

**取景框盖住副标题**

`PreviewView` 是原生 View，会按自身尺寸溢出父容器；圆角背景只是画在下面，
不裁剪子 View。加 `Modifier.clip()` 解决。

**写死 400dp 高度**

在小屏/大字体下会把说明和按钮挤出屏幕。改用 `aspectRatio(0.85f)`
并让整列可滚动。

---

## [0.2.3] — 2026-11-26

### 修复

**截图被 Hub 拒绝（`not a PNG`）**

手机截图默认是 **JPG**（小米实测），而协议要求 PNG。原先直接把 JPG 字节打上
`image/png` 标签发出去，Hub 校验魔数失败拒绝。现在手机端真实转码为 PNG，
且哈希改用**转码后**的内容（Hub 校验的是实际收到的字节）。

---

## [0.2.2] — 2026-11-25

### 修复

**Android 拦截明文 HTTP，配对必然失败**

Android 9+ 默认禁止明文 HTTP，而 LinkOK 的前提就是局域网 `http://192.168.x.x:8787`。
缺少 `network_security_config` 时所有请求抛
`UnknownServiceException: CLEARTEXT communication not permitted`，即使密码正确也配不上。

---

## [0.2] — 2026-11-25

### 新增

- **首页显示最近一次剪贴板同步**：方向、文本预览、字符数，可关闭
- **首页无障碍提醒条**：无障碍未开启时提示"手机复制的内容还不会同步到电脑"，
  可跳转设置、可关闭
- **`linkok://pair?...` 深链**：可以直接点开链接配对，不用手敲 74 个字符
- **系统返回键处理**：设置页/配对页返回到首页，首页才退出 App

### 修复

**截图被拒（`not a PNG`）**

手机端从不转码，直接发 JPG 字节。

**配对失效后无法恢复**

手机收到 401 时只会无限重试，表现是永远"未连接"，且"重新配对"似乎没反应
（旧的失败循环在后台打断新尝试）。现在 401 立即停止重连、清除本地 token、
自动回到扫码页。

**「扫码配对」按钮不会扫码**

按钮只切换出一个文本框，zxing 依赖写在 `build.gradle.kts` 里却从未被调用。

---

## [0.1.0] — 2026-11-25

首个可运行版本。

### 新增

- Kotlin + Compose + Material 3，前台服务、Stash（保存/丢弃/批量）、
  无障碍剪贴板同步、快捷设置磁贴、开机自启
- 验证：构建 → 安装 → 启动 → 渲染，真机零崩溃
