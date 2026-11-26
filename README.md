# LinkOK

个人用的局域网剪贴板 + 截图桥。一台 Android 手机，一台 Windows 电脑，无云端。

- **手机截图 → 电脑剪贴板**：手机截完图，电脑直接 Ctrl+V 就能粘贴。
- **电脑截图 → 手机暂存区**：电脑上 `PrtSc`、`Win+Shift+S`、任何复制到剪贴板的图片，都会出现在手机 App 里，一键存进相册。
- **纯文本剪贴板双向同步**：电脑复制，手机剪贴板自动更新，反之亦然。
- **自动清理**：7 / 15 / 30 天或永不，只清 LinkOK 自己的副本，绝不碰你的相册。
- **Windows 通知**：可分类关闭。

设计与协议的完整定义见 [docs/SPEC.md](docs/SPEC.md)；术语以 [CONTEXT.md](CONTEXT.md) 为准。
改了什么、修了什么，见 **[CHANGELOG.md](CHANGELOG.md)**（索引页）。

> **两端版本独立**：
> - **电脑端**版本在 [`version.config`](version.config)，变更记录见 [CHANGELOG-PC.md](CHANGELOG-PC.md)；
>   发版 `.\scripts\release-pc.ps1 -Minor|-Patch "标题"`。运行时访问
>   `http://127.0.0.1:8787/health` 可看到 Hub 版本。
> - **手机 App** 版本在 [`android/version.config`](android/version.config)，变更记录见
>   [CHANGELOG-ANDROID.md](CHANGELOG-ANDROID.md)；发版
>   `.\scripts\release-android.ps1 -Minor|-Patch "标题"`（加 `-Install` 会顺带构建并装到手机）。
>
> 版本规则统一为 `0.MINOR.PATCH`：MINOR = 功能变更/重大修复，PATCH = 小修复。
> APK 的版本串形如 `0.3.2-1126-1030-debug`（语义版本 + 构建时间），
> 在 App 的**欢迎页 / 配对页 / 设置页底部**可看到，用来确认装的是哪一次构建。

> **测试情况**：目前**仅在 Android 13 的小米 M2012K11AC（Redmi K50）与 Windows 11 上实测过**。
> `minSdk` 设为 29（Android 10），其他机型理论上可用，但未经验证。
> iOS 不在范围内（截图监听依赖 Android 的 `MediaStore`，无法实现）。

---

## 目录结构

```
LinkOK/
├── pc/                 电脑端
│   ├── src/            Node Hub（HTTP + WebSocket + 配对 + 历史 + 保留期）
│   ├── helper/         C# 原生桥（剪贴板监听、托盘、二维码窗口）
│   └── public/         设置页（零依赖静态页，Material 3）
├── android/            手机端（Kotlin + Compose + Material 3）
├── scripts/env.ps1     构建环境引导（工具链路径、npm 缓存、沙箱绕行）
├── docs/
│   ├── SPEC.md         产品与工程规格
│   ├── PROTOCOL.md     跨端契约（端点、WS 消息、配对、存储布局）
│   ├── DESIGN-GUIDE.md 设计规范补充
│   └── adr/            架构决策记录
└── start.cmd           一键启动
```

---

## 快速开始

### 1. 启动电脑端

**双击 `LinkOK.exe`**（推荐）。它会找到一个 Node 运行环境、拉起 Hub，并打开一个控制台窗口显示配对信息。

首次启动会做两件事：

1. 在**屏幕上弹出一个二维码窗口**（关掉也能在托盘菜单里再调出来）
2. 在控制台打印配对码

```
LinkOK Hub 0.1.0 is running
  settings   http://127.0.0.1:8787
  LAN        http://192.168.1.100:8787
  paired     no

  ── 首次配对 ──────────────────────────────────
  配对码     5Y87YH
  有效期     19:02:19 前
  二维码内容 linkok://pair?host=192.168.1.100&port=8787&code=5Y87YH&fp=0123456789abcdef
  手机打开 LinkOK → 扫码配对（或粘贴上面这行）
  ─────────────────────────────────────────────
```

配对码有效期 120 秒。过期了就在**托盘图标右键 →「配对新设备」**重新生成一个。

> 如果 `LinkOK.exe` 找不到 Node，会明确告诉你缺什么以及怎么补 —— 它不会一闪而过。

**没有 exe 或想从源码跑**：`start.cmd`（需要 Node 在 PATH 里），或者

```powershell
cd pc
node src/main.js
```

### 2. 装手机端

APK 在 `android/app/build/outputs/apk/debug/app-debug.apk`：

```powershell
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

重新构建：

```powershell
. .\scripts\env.ps1
Invoke-Gradle -ArgumentList 'assembleDebug' -WorkingDirectory "$PWD\android"
```

### 3. 配对

打开 App，三种方式任选：

| 方式 | 做法 |
|---|---|
| **扫码**（最快） | 点「扫码配对」，对准 `LinkOK.exe` 窗口里的二维码 |
| **点链接** | 把 `linkok://pair?...` 发到手机（微信/TIM/记事本），点它直接配对 |
| **粘贴** | 点「扫码不方便？粘贴配对链接」，把整行粘进去 |

> **配对码只有 120 秒有效期。** 过期了就在窗口里点「换个配对码」，或托盘右键 →「配对新设备」。
> 你贴给别人的那行链接如果超过 2 分钟，一定会失败 —— 这是安全设计，不是 bug。

### 4. 关于 exe

根目录的 **`LinkOK.exe`** 是图形界面入口：双击后有窗口、二维码、配对码、日志和三个按钮，关掉窗口会缩到托盘继续运行。

它**不打包 Node 运行时**（那会让体积从 23KB 涨到约 100MB）。它按这个顺序找 Node：

```
环境变量 LINKOK_NODE → 工程内的 node.exe → PATH → C:\Program Files\nodejs\node.exe
```

找不到会弹一个说明清楚的对话框，而不是闪退。

`pc/helper/linkok-helper.exe` 是**内部子进程**，不要直接双击它 —— 它通过 stdin/stdout 和 Hub 通信，单独运行没有意义。

### 4. 让它在后台活下来（小米必做）

MIUI 会杀后台。首次打开 App 后请在系统设置里：

1. **自启动**：设置 → 应用设置 → LinkOK → 自启动（打开）
2. **省电策略**：同上 → 省电策略 → 无限制
3. **无障碍**（手机→电脑剪贴板同步需要）：设置 → 无障碍 → LinkOK 剪贴板同步（打开）

无障碍被 MIUI 关掉时，手机→电脑的自动同步会停止，但**电脑→手机不受影响**。此时可以在快捷设置里添加「推送剪贴板」磁贴手动发送。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LINKOK_DATA_DIR` | `%LOCALAPPDATA%\LinkOK` | 数据目录（配置、历史、日志、临时文件） |
| `LINKOK_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LINKOK_HELPER_TMP` | `<数据目录>\tmp` | 由 Hub 自动注入给 C# helper，一般不用手设 |

数据目录布局：

```
<数据目录>\
├── config.json         设置
├── device.json         已配对设备与 Token（不要分享这个文件）
├── history\
│   ├── index.json      历史索引（原子写入）
│   └── 2026-11-25\     按日期分目录的 PNG
├── logs\               每日日志
└── tmp\                剪贴板图片中转（helper 用）
```

---

## 构建环境说明

本机**没有 .NET SDK**，也没有全局 JDK/Android SDK。项目通过以下方式做到零额外安装：

| 用途 | 实际使用 |
|---|---|
| C# helper | Windows 自带的 `.NET Framework 4.8` 编译器 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` |
| Android | 复用的自包含工具链：JDK 17 / SDK 34 / Gradle 8.7（路径在 `scripts/env.ps1` 里） |
| 签名 | 工程自带的 `android/keystore/debug.keystore`（不能用默认的 `~/.android`，该目录可能不可写） |

`scripts/env.ps1` 会把 `GRADLE_USER_HOME` 指向工程内的 `.gradle-home`。**不要**共享其他工程的 Gradle 缓存，那份缓存里的 `native-platform.dll` 可能已损坏，会导致 `Could not initialize native services`。

---

## 已知限制

- **仅 Android**。截图监听依赖 `MediaStore`，iOS 无法实现。
- **手机→电脑剪贴板**依赖无障碍服务。这是 Android 10+ 的限制：应用只能在前台读剪贴板。见 [ADR 0002](docs/adr/0002-screenshot-delivery-and-clipboard.md)。
- **「复制图片」也算截图**。这是有意的简化：电脑剪贴板里出现的任何图片都会发到手机。不想要就点「丢弃」。
- **不做端到端加密**。局域网 + Token 认证，对个人使用足够。
- 单张图上限 **20MB**，剪贴板文本上限 **64KB**。

---

## 常见问题

**手机连不上电脑？**
确认在同一 WiFi；确认 Windows 防火墙允许 Node 的入站连接（首次运行会弹窗）；`GET /health` 应该能在电脑浏览器打开。

**电脑的 IP 变了怎么办？**
配对时会记录地址；重连失败时手机会用 UDP 广播（8788）重新发现 Hub。若仍失败，重新配对即可。

**托盘图标不出现？**
托盘需要交互式桌面会话。从后台服务或非交互进程启动时 `Shell_NotifyIcon` 会失败（win32=5），但剪贴板监听和截图监听**仍然工作**。

**想清空一切重来？**
退出 Hub，删除 `<数据目录>` 整个文件夹，重新启动会打印新的配对码。手机上「设置 → 解除配对」再重新扫码。
