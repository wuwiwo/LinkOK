# LinkOK — 产品与工程规格书

> 状态：**待审阅**｜版本 0.1｜术语以 [CONTEXT.md](../CONTEXT.md) 为准

---

## 1. 这是什么

LinkOK 是一个**个人用、单用户、纯局域网、无云端**的双设备桥：

- 一台 **Xiaomi M2012K11AC（Redmi K50）Android 13** 手机
- 一台 **Windows 11 26H2** 电脑

它解决两件事：**截图在两端秒级互通**，以及**纯文本剪贴板双向同步**。

设计立场：不追求跨平台、不追求多人、不追求云端。所有取舍偏向"个人日常用得爽、不打扰、不丢东西"。

---

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 | 可验收标准 |
|---|---|---|
| G1 | 手机截图后电脑立刻可用 | 截屏 → 手机前台服务发出 → 电脑剪贴板就绪，**同一 WiFi 下 P95 ≤ 2s** |
| G2 | 电脑截图后手机可手动保存 | 电脑出现图片 → 手机 Stash 出现该图，**P95 ≤ 2s**；一键 Save 进系统相册 |
| G3 | 纯文本剪贴板双向同步 | 电脑复制 → 手机剪贴板自动变；手机复制 → 电脑剪贴板变（无障碍在位时自动） |
| G4 | 旧截图自动清理 | 可选 7/15/30/永不，默认 30；按 Arrival Time 计，只清 LinkOK 自己的副本 |
| G5 | Windows 通知可关 | 总开关 + 三类细分开关，默认值见 §7 |
| G6 | 样式简约美观 | 两端同一套 Material 3 token；浅/深跟随系统；Android 12+ 动态取色 |

### 2.2 非目标（明确不做）

- ❌ iOS、macOS、Linux 客户端
- ❌ 云端中转、账号体系、多用户、端到端加密（局域网 + Token 已足够）
- ❌ 文件传输、富文本/HTML 剪贴板、剪贴板历史（只保留"当前值"）
- ❌ 手机端清理系统相册里的既有照片
- ❌ 公网访问、内网穿透

---

## 3. 系统架构

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Phone (Android 13)      │         │  PC (Windows 11)             │
│                          │         │                              │
│  ┌────────────────────┐  │  WS     │  ┌────────────────────────┐  │
│  │ Foreground Service │◄─┼─────────┼─►│ Hub (Node process)     │  │
│  │  - MediaStore obs. │  │  HTTP   │  │  - HTTP/WS server      │  │
│  │  - Clipboard Sync  │  │         │  │  - Clipboard watcher   │  │
│  │  - WS client       │  │         │  │  - Screenshot watcher  │  │
│  └────────────────────┘  │         │  │  - JSON index store    │  │
│  ┌────────────────────┐  │         │  │  - Retention sweeper   │  │
│  │ Compose UI (M3)    │  │  UDP    │  └────────────────────────┘  │
│  │  - Stash           │  │◄───────►│  ┌────────────────────────┐  │
│  │  - Settings        │  │broadcast│  │ Tray icon (Win32)      │  │
│  └────────────────────┘  │         │  └────────────────────────┘  │
│  ┌────────────────────┐  │         │  ┌────────────────────────┐  │
│  │ Accessibility Svc  │  │         │  │ Web settings (M3)      │  │
│  └────────────────────┘  │         │  │  served by Hub         │  │
└──────────────────────────┘         │  └────────────────────────┘  │
                                     └──────────────────────────────┘
```

**权威状态在 PC（Hub）。** 手机是主动连接方，PC 不主动发起连接（除 UDP 应答）。

### 3.1 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 手机 UI | Kotlin + Jetpack Compose + Material 3 | 谷歌最新规范；与 PC 网页共享同一套 token |
| 手机后台 | Foreground Service + `ContentObserver` on `MediaStore` | 唯一能实时感知截图的合规方式 |
| 手机存储 | App 私有目录 + DataStore（无 Room） | 个人数据量小，避免原生依赖 |
| 手机网络 | OkHttp WebSocket | 长连接 + 断线重连成熟 |
| PC 运行时 | Node.js（无 Electron） | 体积小，个人工具不该背 100MB+ |
| PC 原生桥接 | **C# / .NET Framework 4.8**，用系统自带 `csc.exe` 编译 | 无需下载 SDK；WinForms + P/Invoke 最顺 |
| PC 剪贴板 | 原生 Win32 调用（`AddClipboardFormatListener`），在 C# helper 内 | 轮询会漏内容且耗 CPU |
| PC 托盘 | 原生 Win32 `Shell_NotifyIcon`，在 C# helper 内 | 避免 Electron，也不需要完整 GUI 框架 |
| PC 设置页 | 单页静态前端，Hub 直接 serve | 零构建步骤，改完刷新即见 |
| PC 存储 | 目录 + JSON 索引 | 避免 `node-sqlite3` 的原生编译 |
| Android 最低版本 | `minSdk 29`（Android 10） | 只在真机 Android 13 验证，但声明支持 10+ 以免被系统拒绝安装 |

### 3.1.1 PC 原生桥接的构建方式（已验证）

本机 `.NET` 状态实测：

| 项 | 实际值 |
|---|---|
| .NET SDK | **不存在**（`C:\Program Files\dotnet\sdk` 无此目录） |
| .NET 运行时 | 6.0.36、8.0.34（仅运行时，**不能编译**） |
| .NET Framework | **4.8.10008**（Release 534296） |
| 自带编译器 | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` v14.8.10001 |

**结论：C# helper 用系统自带 `csc.exe` 编译，不需要安装任何 SDK。**

已验证可编译并运行含 `NotifyIcon`（WinForms）、`System.Drawing.Bitmap`、P/Invoke 的程序，且 `DataFormats` 的 PNG/Bitmap 格式 ID 均正常解析。

编译命令形态：

```powershell
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$args = @('/nologo','/target:winexe','/out:helper.exe',
  ('/reference:"{0}\System.Windows.Forms.dll"' -f $fw),
  ('/reference:"{0}\System.Drawing.dll"' -f $fw),
  ('/reference:"{0}\System.dll"' -f $fw),
  'Helper.cs')
Start-Process "$fw\csc.exe" -ArgumentList $args -Wait -NoNewWindow
```

**约束**：引用路径含空格，**必须加引号**，否则 `csc` 会把路径拆开（已踩过）。
**约束**：只能使用 .NET Framework 4.8 API，不可用 .NET 8 的 `System.Text.Json` 等；helper 与 Node 之间用 stdio 传 JSON 行即可，不需要这些新 API。

---

## 4. 领域模型

完整术语表见 [CONTEXT.md](../CONTEXT.md)。关键实体与流转：

```
        手机截图                    电脑截图 / 复制图片
            │                               │
            ▼                               ▼
      Phone Capture                   PC Capture
            │                               │
            │  (WS 上行)                    │  (WS 下行)
            ▼                               ▼
   ┌─────────────────┐            ┌─────────────────┐
   │ PC Clipboard    │            │ Phone Stash     │
   │ + PC History    │            │ (待处置)         │
   └─────────────────┘            └────────┬────────┘
                                           │
                              ┌────────────┴────────────┐
                              ▼                         ▼
                          Save (搬走)              Discard (删除)
                              │
                              ▼
                   系统相册 Pictures/LinkOK
                   （Retention 永不触碰）
```

**三条不变量（Invariants）**

1. **Echo 抑制**：LinkOK 自己写入剪贴板的内容，永不被当成用户新复制而回传。
2. **Retention 边界**：清理只能删 LinkOK 自己创建的副本；系统相册与用户自己的截图文件夹是禁区。
3. **去重**：内容哈希相同的 Capture 在同一端只投递一次。

---

## 5. 功能规格

### 5.1 手机 → 电脑（Phone Capture）

| 项 | 规格 |
|---|---|
| 触发 | `ContentObserver` 监听 `MediaStore.Images` 中 `DCIM/Screenshots` 的新增项 |
| 传输 | WS 二进制帧 + 元数据（捕获时间、原始文件名、MIME、哈希） |
| 格式 | 统一转 **PNG** 送 PC（保真优先） |
| 大小上限 | 单张 **20MB**，超限拒绝并记录一条异常日志 |
| 电脑侧效果 | ① 写入 Windows 剪贴板（图片格式）② 存一份 History ③ 弹"已收到"通知（默认开，带缩略图） |
| 去重 | 收到后按 SHA-256 比对 History，重复则丢弃，不写剪贴板 |
| 时延目标 | 同一 WiFi，P95 ≤ 2s |

### 5.2 电脑 → 手机（PC Capture）

**两个来源，缺一不可：**

| 来源 | 实现 | 覆盖场景 |
|---|---|---|
| 剪贴板出现图片 | `AddClipboardFormatListener` 监听 `CF_DIB`/`CF_BITMAP`/`CF_PNG` | `PrtSc`、`Win+Shift+S`、浏览器"复制图片"、微信复制图片 |
| 截图文件夹新增 | `FileSystemWatcher` 监听系统截图目录 | 截图工具保存、游戏栏保存、OneDrive 同步下来的截图 |

系统截图目录从注册表 `User Shell Folders\{374DE290-...}` 解析（本机实测为 `E:\download`，会动态读取，不写死）。

| 项 | 规格 |
|---|---|
| 电脑侧效果 | 发到手机 Stash，**静默**（不弹手机通知） |
| 手机侧效果 | Stash 顶部出现最新大图卡；前台服务常驻通知显示"待保存 N 张" |
| 去重 | 两来源可能同时命中同一张图，按 SHA-256 去重后再下行 |
| 时延目标 | P95 ≤ 2s（Link 在线时） |

### 5.3 Stash 的处置

| 动作 | 行为 |
|---|---|
| **Save** | 通过 `MediaStore` 写入 `Pictures/LinkOK/`，随后**从 Stash 移除**（不留副本） |
| **Discard** | 从 Stash 删除，无二次确认（长按多选时统一确认） |
| 批量 | 长按进入多选，支持批量 Save / 批量 Discard |
| 容量保护 | Stash 额外设 **500MB** 上限，超出时从最旧开始清（独立于 Retention） |

### 5.4 剪贴板同步

| 方向 | 触发 | 默认 |
|---|---|---|
| PC → Phone | 监听 PC 剪贴板文本变化 → WS 下行 → 手机写剪贴板 | **全自动** |
| Phone → PC | Accessibility Service 读剪贴板 → WS 上行 → PC 写剪贴板 | **全自动（无障碍在位时）** |
| Phone → PC 降级 | 快捷设置磁贴"推送剪贴板" / App 在前台时自动 | 手动或前台自动 |

**约束**

- 只传**纯文本**。图片走 Capture 通道，不走 Clipboard Sync。
- 冲突策略：**后到者胜**（last writer wins），无合并、不报错。
- **Echo 抑制**：两端各自维护"最近一次自己写入的内容哈希"，命中则忽略。
- 长度上限：**64KB** 文本，超限截断并提示（防止误传大段内容）。

### 5.5 配对与发现

**配对流程**

1. PC 托盘右键 → "配对新设备"，或设置页 → 设备 → 配对新设备。
2. 弹出小窗显示二维码，内容 = `linkok://pair?host=<ip>&port=<port>&code=<一次性码>&fp=<证书指纹>`。
3. 手机 App 首次启动进入扫描页，扫码后 `POST /pair`，携带一次性码与设备标识。
4. Hub 校验一次性码（**有效期 120 秒**，用后即焚），签发**长期 Token** 返回手机。
5. 手机安全存储 Token，此后所有请求带 `Authorization: Bearer <token>`。

**重新配对**：生成新 Token 并吊销旧 Token（旧设备立即 401）。

**地址发现**

- 手机保存上次的 `host:port`。
- Link 断开且直连失败时，手机向 `255.255.255.255:8788` 发 UDP 探测包（携带 Token 指纹）。
- Hub 收到合法探测后应答自身当前地址。
- 手机用新地址重连，**无需重新配对**。

### 5.6 Retention（清理）

| 项 | 规格 |
|---|---|
| 作用对象 | 手机 Stash + PC History（各自清理，互不代劳） |
| 档位 | **7 天 / 15 天 / 30 天 / 永不**，默认 **30 天** |
| 计时基准 | **Arrival Time**（进入 LinkOK 的时刻），非图片自身时间戳 |
| 执行时机 | 每小时一次 + 每次 App/服务启动时 |
| 禁区 | 系统相册、用户自己的截图文件夹 |
| 永不档 | 完全不自动删除，只受 Stash 500MB 容量保护约束 |

### 5.7 通知

**Windows：总开关 + 三类细分**

| 类别 | 默认 | 内容 |
|---|---|---|
| 截图送达 | **开** | "已收到手机截图" + 缩略图，点击打开设置页历史 |
| 剪贴板同步 | **关** | 防刷屏；开启后每次同步弹一条 |
| 异常 / 断线 | **开** | 手机离线超 5 分钟、端口占用、配对失败等 |

**手机：无通知**

- PC Capture 静默入 Stash。
- 唯一的常驻通知是前台服务本身（Android 强制要求），文案显示待保存数量，不可关闭（系统限制），但可设为"静默"。

### 5.8 托盘

| 菜单项 | 行为 |
|---|---|
| 状态区（不可点） | "已连接：Redmi K50" / "手机未连接" |
| 打开设置 | 打开浏览器到 `http://127.0.0.1:<port>` |
| 配对新设备 | 显示二维码小窗 |
| 暂停同步 | 临时停止收发（不做断开） |
| 开机自启 | 勾选开关 |
| 退出 | 真正结束进程 |

图标状态：**连接中（正常）/ 断开（灰）/ 暂停（斜杠）**。

---

## 6. UI 规格（Material 3）

### 6.1 设计 token

- **色彩**：Material 3 `ColorScheme`；Android 12+ 用 `dynamicLightColorScheme`/`dynamicDarkColorScheme`，低版本回退到固定品牌色（一种偏蓝的 primary）。
  - **不引入语义化的绿/黄/红**。M3 没有 success 角色；"已连接"用 `primary` 圆点，未连接用 `outline` 圆点。
  - **状态永不只靠颜色传达**：圆点旁必须有文字（`已连接` / `未连接`）。
- **主题**：浅色/深色**跟随系统**，两端一致。
- **字体**：Material 3 默认字阶（`displaySmall` / `titleLarge` / `bodyMedium` / `labelLarge`）。设备名用 `titleMedium`，传输信息用 `bodySmall`。
- **间距**：8dp 基准栅格。
- **动效**：M3 标准 easing；列表进入用 fade+scale，时长 200ms。**不做自动循环动画**。

#### 形状标度

只用 M3 形状标度上的值，不自造：

| 用途 | 圆角 | M3 token |
|---|---|---|
| 主卡片（bridge 状态） | `28dp` | `extraLarge` |
| 普通卡片 | `16dp` | `large` |
| 缩略图、内层表面 | `12dp` | `medium` |
| 小控件（chip、输入框） | `8dp` | `small` |
| 按钮 | full-round | `full` |

#### 同心圆角规则

嵌套表面之间存在**可见且均匀的内边距**时：

```
外圆角 = 内圆角 + 内边距 + 边框宽度
```

按 M3 标度落地的组合（全部落在标度上）：

| 外层 | 内边距 | 由此推出的内层 |
|---|---|---|
| `28dp` extraLarge | `8dp` | `20dp` largeIncreased |
| `16dp` large | `8dp` | `8dp` small |
| `12dp` medium | `4dp` | `8dp` small |

**例外**：内边距超过 `24dp`，或内边距刻意不对称时，两层视为独立表面，各用各的标度 token，不强求同心。

**反例**（不要这样）：

```kotlin
// 内外同圆角 → 视觉上内层显得更方，角落出一道月牙
Surface(shape = RoundedCornerShape(16.dp)) {
    Box(Modifier.padding(8.dp)) {
        Surface(shape = RoundedCornerShape(16.dp)) { }
    }
}
```

#### 内容列宽

设置页正文列 `max-width: 640px`，行长控制在 80 字符内。手机端由 `WindowSizeClass` 决定单列或双栏，不做无限拉伸。

### 6.2 手机端（单页）

```
┌─────────────────────────────┐
│  LinkOK            ⚙  ⏸     │  ← TopAppBar（小标题栏）
├─────────────────────────────┤
│  ● 已连接 · 192.168.1.x    │  ← 连接状态条（可点重连）
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │                         │ │  ← 最新 Capture 大图卡（28dp 圆角）
│ │        (预览图)          │ │     底部两个 Filled 按钮
│ │                         │ │
│ └─────────────────────────┘ │
│   [ 保存 ]      [ 丢弃 ]     │
├─────────────────────────────┤
│  今天                        │  ← 日期分组标题
│  ┌────┐ ┌────┐ ┌────┐       │  ← 3 列缩略图网格
│  │    │ │    │ │    │       │     长按进入多选
│  └────┘ └────┘ └────┘       │
│  昨天                        │
│  ┌────┐ ┌────┐              │
│  └────┘ └────┘              │
├─────────────────────────────┤
│  空状态：                    │
│  "还没有收到截图"             │  ← 居中插画 + 一行说明
└─────────────────────────────┘
```

- **设置**（右侧图标进入）：保留期档位、通知（手机端无项，仅展示权限状态）、配对信息、无障碍开关引导、磁贴开关引导、关于。
- **多选态**：顶栏变为"已选 N 项"，操作栏出现"保存 / 丢弃"。
- **下拉刷新**：触发一次与 PC 的状态对账。

### 6.3 电脑端设置页（单页，左侧导航）

**设计意图**：LinkOK 的页面首要问题是“**现在通不通**”，不是“功能清单”。因此连接状态**独占一个有高程的主卡片**，其余信息用扁平行，不与它平起平坐。

```
┌──────────┬──────────────────────────────────────────┐
│ LinkOK   │  ┌────────────────────────────────────┐  │
│          │  │  ┌────┐            ┌────┐          │  │  ← 唯一主卡片
│ ▸ 概览   │  │  │ PC │━━━━━━━━━━━━│手机│          │  │     28dp 圆角
│ ▸ 历史   │  │  └────┘            └────┘          │  │     tonalElevation 1dp
│ ▸ 设备   │  │  这台电脑            Redmi K50      │  │
│ ▸ 设置   │  │  192.168.1.100:8787   已连接        │  │
│          │  └────────────────────────────────────┘  │
│          │                                          │
│          │  本次会话 ──────────────── 12 张         │  ← 扁平行，非卡片
│          │  最近一张 ────── [缩略] 16:46            │
│          │                                          │
│          │  [ 配对新设备 ]   [ 暂停同步 ]           │
└──────────┴──────────────────────────────────────────┘
```

**概览页的结构约束**

| 层级 | 元素 | 处理 |
|---|---|---|
| 1 | 连接状态 | **唯一的卡片**，`28dp` 圆角，`tonalElevation 1dp` |
| 2 | 本次会话传输数、最近一张 | 扁平 `ListItem` 行，`outlineVariant` 细分隔线 |
| 3 | 操作按钮 | 底部一行，一个 `Filled` 主按钮 + 一个 `Outlined` 次按钮 |

**明确不做**：三个并列圆角卡、每张卡各自投影、卡片数量随功能增加而增加。这正是模板化默认解的形态。

| 分区 | 内容 |
|---|---|
| **概览** | 连接状态（主卡片）、本次会话传输计数、最近一张 Capture、快捷操作（配对新设备 / 暂停） |
| **历史** | 按日期分组的列表；每项走 `ListItem`，可复制到剪贴板、在文件夹中显示、删除 |
| **设备** | 已配对设备列表、配对新设备按钮、二维码弹窗 |
| **设置** | 端口、保留期（7/15/30/永不）、三类通知开关、开机自启、存储路径（只读展示 + 打开目录）。设置项一律 `ListItem` + 尾部控件，**不装箱成卡片** |

**视觉**

- 左侧 `NavigationRail`（`surfaceContainer` 底），右侧正文列 `max-width: 640px`。
- 响应式：窄屏（<840dp）折叠为顶部 Tab，正文列自适应。
- 全页**只有一个**有高程的表面（概览主卡片）；历史、设备、设置三个分区没有任何卡片。

---

## 7. 默认值总表

| 编号 | 默认值 |
|---|---|
| D1 | Hub 端口 **8787**（UDP 发现端口 8788），设置页可改 |
| D2 | PC History 路径 `%LOCALAPPDATA%\LinkOK\history`，按 `YYYY-MM-DD` 分目录 + `index.json` |
| D3 | 图片统一转 **PNG**；单张上限 **20MB**，超限拒绝并提示 |
| D4 | 剪贴板文本上限 **64KB** |
| D5 | Stash 容量上限 **500MB**，超出从最旧清 |
| D6 | 保留期默认 **30 天** |
| D7 | 配对码有效期 **120 秒** |
| D8 | 界面语言**简体中文**；代码标识符全英文（与 CONTEXT.md 一致） |
| D9 | 断线重连指数退避：1s → 2s → 4s → … 上限 30s |
| D10 | 手机离线判定阈值 **5 分钟**（触发异常通知） |

---

## 8. 数据模型

### 8.1 PC History 索引（`index.json`）

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "2026-11-25T16:46:51.132+08:00_3f2a1b",  // Arrival Time + 短哈希
      "sha256": "3f2a1b…",
      "source": "phone" | "pc-clipboard" | "pc-folder",
      "arrivedAt": "2026-11-25T16:46:51.132+08:00",
      "file": "2026-11-25/2026-11-25T16-46-51-132_3f2a1b.png",
      "bytes": 482133,
      "width": 1080,
      "height": 2400
    }
  ]
}
```

### 8.2 手机 Stash 索引（DataStore）

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "…",
      "sha256": "…",
      "arrivedAt": "2026-11-25T16:46:51.132+08:00",
      "fileName": "….png",
      "bytes": 482133,
      "savedAt": null          // 非 null 表示已 Save
    }
  ]
}
```

### 8.3 配置（两端各一份）

```jsonc
{
  "port": 8787,
  "retentionDays": 30,          // 7 | 15 | 30 | 0(=永不)
  "notifications": {
    "enabled": true,
    "captureDelivered": true,
    "clipboardSynced": false,
    "errors": true
  },
  "autostart": true,
  "screenshotDir": "E:\\download"
}
```

---

## 9. 接口契约

### 9.1 认证

- 除 `POST /pair` 与 `GET /health` 外，所有端点要求 `Authorization: Bearer <token>`。
- 未授权返回 `401 {"error":"unauthorized"}`。

### 9.2 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 无鉴权存活探测，返回 `{ok, version, paired}` |
| `POST` | `/pair` | 用一次性配对码换 Token，`{code, deviceName, deviceModel}` → `{token}` |
| `GET` | `/api/state` | 当前配置 + 连接状态（设置页用） |
| `PATCH` | `/api/config` | 更新配置（保留期、通知、端口等） |
| `GET` | `/api/history?from=&to=&limit=` | 历史列表 |
| `GET` | `/api/history/:id/raw` | 原图 |
| `DELETE` | `/api/history/:id` | 删除一条历史 |
| `POST` | `/api/pairing-code` | 生成新的一次性配对码（托盘/设置页调用） |
| `POST` | `/api/device/revoke` | 吊销 Token |
| `WS` | `/ws` | 主通道：Capture 上下行、剪贴板同步、心跳 |

### 9.3 WebSocket 消息

```jsonc
// 上行（手机 → PC）
{ "type": "capture", "id": "…", "sha256": "…", "arrivedAt": "…", "mime": "image/png" }
// 随后发二进制帧（图像本体）

{ "type": "clipboard", "text": "…", "sha256": "…" }
{ "type": "ack", "id": "…" }
{ "type": "ping" }

// 下行（PC → 手机）
{ "type": "capture", "id": "…", "sha256": "…", "arrivedAt": "…", "mime": "image/png" }
// 随后发二进制帧

{ "type": "clipboard", "text": "…", "sha256": "…" }
{ "type": "capture-result", "id": "…", "ok": true }
{ "type": "pong" }
```

**大图分帧**：超过 1MB 的二进制按 256KB 切片，带 `seq`/`total`，接收端重组。

---

## 10. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 手机不在同一 WiFi | Link 断开，托盘图标变灰，5 分钟后发一次异常通知（不重复轰炸） |
| 电脑 IP 变化 | UDP 重发现，静默重连；日志记录一条 |
| 手机被 MIUI 杀进程 | 前台服务重启；仍失败则托盘变灰 + 通知"手机已离线" |
| 无障碍被关 | 手机端设置页显示红色提示条 + 一键跳转系统设置；PC→Phone 不受影响 |
| 图片 >20MB | 拒绝传输，两端各记一条；手机端 toast 提示 |
| 剪贴板 >64KB | 截断传输并提示 |
| 端口被占用 | Hub 启动失败，托盘显示错误图标，弹窗提示改端口 |
| 磁盘写满 | 停止写入并通知；绝不静默丢弃 |
| 重复配对 | 新 Token 生效，旧 Token 立即失效 |

---

## 11. 交付物

| # | 交付物 | 验收方式 |
|---|---|---|
| 1 | `pc/` — Node Hub + 设置页 | `node pc/src/main.js` 启动，浏览器打开可用 |
| 2 | `android/` — Kotlin 工程 | `gradlew assembleDebug` 出 APK |
| 3 | `LinkOK-debug.apk` | adb 装到你的 Redmi K50 |
| 4 | 开机自启注册脚本 | 重启后托盘自动出现 |
| 5 | `README.md` | 从零到可用的步骤 |
| 6 | `CONTEXT.md` + `docs/adr/000{1,2,3}` | 已完成 |

**工具链**：复用 `<工具链目录>` 中的 JDK 17 / SDK 34 / Gradle 8.7，并把 `JAVA_HOME`、`ANDROID_HOME` 写入系统环境变量。

---

## 12. 风险与已知取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| MIUI 杀后台 | 手机→PC 断连 | 首次启动引导开"自启动/无省电限制"；前台服务 + 断线重连 |
| 无障碍被系统关闭 | 手机→PC 剪贴板失效 | 磁贴/前台降级；设置页红色提示条 |
| 剪贴板读图需原生 Win32 | Node 自身无剪贴板图片 API | 用 C# helper 进程，Node 与它走 stdio 传 JSON 行，避免编译 Node 原生模块。见 §3.1.1 |
| 本机无 .NET SDK | 无法 `dotnet build` | 改用 .NET Framework 4.8 自带的 `csc.exe`，已实测通过 |
| 截图目录被 OneDrive 重定向 | 监听错目录 | 启动时从注册表动态解析，设置页可覆盖 |
| 手机空间仅 5.1G | 存不下 | Stash 500MB 上限 + 默认 30 天保留期 |

---

## 13. 实施顺序（确认后执行）

1. **M1** 仓库骨架 + 工具链环境变量
2. **M2** PC Hub：HTTP/WS 服务、配对、JSON 索引、Retention
3. **M3** PC 原生 helper：剪贴板监听 + 托盘（Win32，stdio 桥接）
4. **M4** PC 设置页（M3 单页）
5. **M5** Android：脚手架、WS 客户端、前台服务 + MediaStore 监听
6. **M6** Android：Stash UI + Save/Discard
7. **M7** Android：无障碍剪贴板 + 磁贴
8. **M8** 端到端联调 + adb 安装 + README

---

## 14. 已拍板的三处

| # | 问题 | 决定 | 理由与代价 |
|---|---|---|---|
| Q1 | PC 原生 helper 用 C# 还是 Node 原生模块？ | **C# / .NET Framework 4.8**，系统自带 `csc.exe` 编译 | 本机无 .NET SDK，但 Framework 4.8 自带编译器**已实测可编译可运行**（见 §3.1.1）。WinForms/P/Invoke 对剪贴板与托盘最顺。代价：不可用 .NET 8 新 API |
| Q2 | 二维码库：自写还是引三方？ | **引三方** — PC 用 `qrcode`（npm），Android 用 `zxing` | 自写 QR 编码器不值得，且容易在校验位上出错。引库前需确认 `qrcode` 无原生编译依赖 |
| Q3 | Android 最低版本 | **`minSdk 29`（Android 10）**，不设 maxSdk | 只在真机 Android 13 实测；声明 10+ 避免换机或重装时被系统以版本不符拒绝。不写向下兼容分支，用不到的新 API 仍按 29 判断 |
