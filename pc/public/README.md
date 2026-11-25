# LinkOK 设置页（`pc/public/`）

Hub 用 `GET /` 直接 serve 这个目录。**零依赖、零构建**：没有 npm 包、没有 Tailwind、没有框架、没有 CDN、没有外置字体。改完文件刷新页面就生效。

- 文件清单见下
- 预览方法见 [怎么预览](#怎么预览)
- Hub 必须满足的契约见 [API 契约](#api-契约)
- 已知的 SPEC 矛盾见 [与 SPEC 的出入](#与-spec-的出入)

## 文件清单

```
pc/public/
├── index.html            页面外壳。NavigationRail + 内容区 + 脚本清单
├── styles/
│   ├── tokens.css        M3 token 唯一来源：色彩角色、形状标度、字阶、间距、动效
│   └── app.css           所有组件样式。不含任何 --md-sys-* 以外的自定义颜色
├── js/
│   ├── icons.js          内联 SVG 图标集（Material Symbols 几何），无图标字体
│   ├── util.js           时间/字节/尺寸格式化、日期分组、载荷构造（纯函数）
│   ├── ui.js             snackbar、模态框、图标水合、事件委托
│   ├── qr.js             QR 编码器（字节模式，版本 1–10，L/M/Q/H）
│   ├── demo.js           演示数据（形状与真实 API 完全一致）
│   ├── api.js            同源 fetch 封装 + token 解析 + demo 传输
│   ├── views/
│   │   ├── overview.js   概览：唯一的高程卡片 + 扁平行
│   │   ├── history.js    历史：按日期分组，行内三个操作
│   │   ├── devices.js    设备：已配对列表 + 配对二维码弹窗
│   │   └── settings.js   设置：端口/保留期/通知/自启/存储路径
│   └── app.js            hash 路由、状态归属、启动
└── README.md
```

**为什么是经典脚本而不是 ES module**：Chrome 在 `file://` 下拒绝加载
`<script type="module">`（CORS），而本页必须支持"直接双击 HTML 打开 + `?demo=1`"的
评审方式。因此所有脚本都是 `defer` 的经典脚本，共享一个全局命名空间 `LinkOK`。
通过 Hub 访问时行为完全相同。

---

## 怎么预览

### 方式一：接真 Hub（推荐）

```powershell
node pc/src/main.js          # 或你们实际的启动命令
# 浏览器打开 http://<PC 的局域网 IP>:8787/
```

页面会用同源 cookie / meta / sessionStorage 里的 token 访问 `/api/*`。

### 方式二：无 Hub，纯演示（`?demo=1`）

```
# 由 Hub serve：
http://127.0.0.1:8787/?demo=1

# 或者直接双击文件打开，完全不需要任何服务器：
pc\public\index.html?demo=1
```

> 注意：`file://` 下必须带上 `?demo=1`，因为浏览器不会让 `file://` 页面
> 去 `fetch` `/api/state`（会得到 network error）。不带参数直接打开也能看到页面，
> 但会显示"读不到 Hub 的状态"的错误态 —— 这也是真实失败时的样子。

`?demo=1` 时**完全不发起任何网络请求**，用的是 `js/demo.js` 里生成的 12 条示例
截图（按当前时间倒推，所以"今天/昨天"分组和相对时间永远有内容）。界面上会有一条
"演示数据"的提示条，不会把假数据伪装成真数据。

在真实 Hub 打开时，如果 `/api/state` 失败（Hub 没起来 / 401 / 端口不对），页面会显示
**带原因的錯誤横幅 + 重试 + 用演示数据看看** 三个出口，不会是白屏。

### 主题与窄屏

- 浅色/深色跟随 `prefers-color-scheme`，也可强制：`document.documentElement.dataset.theme = 'dark'`
- 窗口窄于 840px 时左侧 NavigationRail 折叠为顶部 Tab

---

## API 契约

### 1. 静态资源

Hub 必须从 `pc/public/` 提供：

| 路径 | 说明 |
|---|---|
| `GET /` | 返回 `index.html`，**不需要鉴权**（PROTOCOL §2） |
| `GET /styles/*.css`、`GET /js/*.js` | 同目录静态文件，正确的 MIME（`.css` → `text/css`，`.js` → `text/javascript`） |

所有引用都是**相对路径**，所以 Hub 绑定什么地址、什么端口都不影响。
请拒绝 `..` 与编码后的穿越。

### 2. Token 怎么交给页面

页面按以下顺序取 token，**Hub 实现任意一种即可**：

| 优先级 | 方式 | Hub 要做什么 | 备注 |
|---|---|---|---|
| 1 | `<meta name="linkok-token" content="<token>">` | 注入到 `index.html` 的 `<head>` | 仅在同源可信环境可接受 |
| 2 | `sessionStorage["linkok.token"]` | 无需操作 | 页面自己从 `?token=` 写入 |
| 3 | **HttpOnly cookie**（推荐） | `GET /` 时回 `Set-Cookie: linkok_token=<token>; Path=/; HttpOnly; SameSite=Strict` | 页面 `fetch` 用 `credentials: 'same-origin'`，浏览器自动带上 |
| 4 | `?token=<token>` 查询串 | 交给页面自己处理 | 页面会立即从地址栏抹掉并转存 sessionStorage |

- 拿到了 token（1/2/4）时，页面**同时**发 `Authorization: Bearer <token>`；和 cookie 并存无害。
- 只走 cookie（方式 3）时，页面完全不知道 token 是什么，也不需要知道。
- Hub 若选择注入 meta，请**替换 `<!-- linkok:head-end -->` 这一行**来插入标签，
  不要用"匹配注释里的示例"来定位 —— 注释里刻意不写出可被匹配到的标签字面量。

### 3. 端点

除标注外都需要鉴权。四个分区用到的端点如下（✓ = 本页调用）。

| 方法 | 路径 | 鉴权 | 本页用途 | 期望响应 |
|---|---|---|---|---|
| `GET` | `/health` | 否 | 未使用（仅人工排查） | `{ok, version, paired}` |
| `GET` | `/api/state` | 是 | 概览/设备/设置 | `{config, connection:{connected,deviceName,since}, paired, paused?, version?, host?}` |
| `PATCH` | `/api/config` | 是 | 设置页所有写入 | 完整 config |
| `GET` | `/api/history?limit=200` | 是 | 概览、历史 | `{items:[HistoryItem]}`，新→旧 |
| `GET` | `/api/history/:id/raw` | 是 | 缩略图 `<img src>` | PNG 二进制 |
| `DELETE` | `/api/history/:id` | 是 | 历史-删除 | `{ok:true}` |
| `POST` | `/api/pairing-code` | 是 | 设备-配对新设备 | `{code, expiresAt, qrPayload, qrSvg?}` |
| `POST` | `/api/device/revoke` | 是 | 设备-吊销 | `{ok:true}` |
| `POST` | `/api/history/:id/copy` | 是 | 历史-复制到剪贴板 | `{ok:true}` |
| `POST` | `/api/reveal` | 是 | 历史/设置-在文件夹中显示 | `{ok:true}` |
| `POST` | `/api/sync` | 是 | 概览-暂停同步 | `{paused:boolean}` |
| `GET` | `/api/devices` | 是 | 设备-已配对列表（可选） | `{devices:[{deviceName,deviceModel,pairedAt,current}]}` |

**可选端点**（`/api/history/:id/copy`、`/api/reveal`、`/api/sync`、`/api/devices`）如果 Hub
还没实现，页面不会假装成功：会返回 404 并在 snackbar 里说明"Hub 还不支持这个操作"。
`/api/devices` 缺失时，设备页退回用 `/api/state.connection` 里的单台设备信息（单手机场景够用）。

**`qrPayload` 必须是权威值**：手机能访问的局域网地址（如
`linkok://pair?host=192.168.1.100&port=8787&code=AB12CD&fp=0123456789abcdef`）。
页面只在 `qrPayload` 缺失时才用 `location` 自己拼——而用托盘打开设置页时
`location.hostname` 是 `127.0.0.1`，这种二维码手机扫了也连不上，页面会显式警告这一点。
`qrSvg` 会被忽略（页面自己画，见下）。

`HistoryItem` 严格按 PROTOCOL §4：
`{id, sha256, source:"phone"|"pc-clipboard"|"pc-folder", arrivedAt, file, bytes, width, height}`。
`id` 不含冒号，页面会把它清洗成 `[A-Za-z0-9_-]` 再拼进 URL，`../` 之类不会穿透。

### 4. 错误

统一 `{error:"machine_readable", message:"人类可读中文"}`。

页面**特别处理 401**：Hub 的 `message` 通常只说"未授权的请求"，页面会自己补上下一步
（"确认 Hub 正在运行，然后重新打开设置页；如果刚刚重装过，需要在手机上重新配对"），
同时保留 Hub 的原文在 `serverMessage` 里。其他状态码直接展示 Hub 的 `message`。

---

## QR 编码器（`js/qr.js`）

自己写的，因为页面必须离线可用，不能引 CDN。范围刻意收窄到够用：

- 字节模式（UTF-8），单段数据
- **版本 1–10**，纠错等级 L/M/Q/H；载荷超过 213 字节会直接抛错而不是画错
- 真正的 Reed–Solomon 纠错、8 种掩码按标准罚分选优（不是固定掩码）
- 输出到 `<canvas>`，按 `devicePixelRatio` 取整数缩放，模块边缘不会糊

已用**独立实现的解码器**验证（不复用编码器的放置/纠错代码）：几何、格式信息、
版本信息、RS 校验子全零、载荷逐字节还原、掩码最优性、以及 canvas 实际绘制的模块
与矩阵逐个比对 —— 27 个断言 × 多个载荷/等级，全绿。详见交付报告里的测试输出。

如果你更希望用 `qrSvg` 直出：目前会忽略它。需要的话可以改成优先用 `qrSvg`，
但那样就必须信任 Hub 的编码实现，且离线评审（无 Hub）时没有二维码可看。

---

## 与 SPEC 的出入

设计时发现的矛盾，以及本页的处理方式。这些没有擅自改文档，留给 SPEC 维护者裁决。

1. **§6.3 说"全页只有一个有高程的表面"，但配对二维码必须弹窗。**
   弹窗（`dialog`）本身是有边界的浮层，不是页面内容。处理：弹窗用
   `surface-container-high` + 28px 圆角，**不加** `tonalElevation` 阴影/高程，
   保证"页面正文里只有一个高程面"这条在字面上仍然成立。

2. **§6.1 的同心圆角表与"内边距 > 24dp 视为独立表面"的例外冲突。**
   例外的阈值写成"超过 24dp"，但表里给的组合最大内边距是 8dp，
   `24dp` 这个数字又恰好是本 SPEC 明令禁止出现在圆角上的值。
   处理：卡片用 28 外层 + 8 内边距 + 20 内层（表内组合），内层容器额外加
   8px 内边距，28 − 8 = 20 保持同心；没有使用 24 作为任何圆角。

3. **PROTOCOL 没有"复制到剪贴板 / 在文件夹中显示"的端点，但 §6.3 要求这两个操作。**
   处理：按需要的形状定义了 `POST /api/history/:id/copy` 与 `POST /api/reveal`
   （见上表），404 时降级为明确提示。**另外**，`navigator.clipboard` 在
   `http://192.168.x.x` 上不可用（非安全上下文），所以浏览器端复制不能作为主路径——
   这一点在 §6.3 里没有体现。

4. **§6.3 要求"暂停同步"按钮，但配置对象（PROTOCOL §7）里没有暂停字段。**
   处理：新增 `POST /api/sync {paused}` 与 `/api/state.paused`。缺失时概览卡片
   会把"已暂停"这个状态当作不可用，按钮仍然存在但失败会说明原因。

5. **§6.1 要求"不引入语义化的绿/黄/红"，但 §10 的错误表格要求异常要有视觉区分。**
   处理：只用 M3 的 `error` 角色（它是 M3 色彩方案的一部分，不属于自造语义色），
   且错误横幅同时有图标 + 标题 + 文字，从不只靠红色。

6. **"设备"分区需要"已配对设备列表"，但契约只给单台设备和 `paired:boolean`。**
   处理：把 `/api/devices` 定为可选端点，缺失时用 `/api/state.connection` 合成一行。
   单手机场景下契约本身是自洽的，列表形态只是为将来留位置。

---

## 设计约束落地（自查）

| 约束 | 落地方式 |
|---|---|
| M3 色彩角色 | `tokens.css` 里逐条声明 `--md-sys-color-*`，浅/深两套，随 `prefers-color-scheme` |
| 形状标度只有 4/8/12/16/20/28/full | 只有 7 个 shape token；**24px 不出现在任何圆角上**（24 只作为 M3 图标盒尺寸与字阶行高出现） |
| 同心圆角 | 卡片 28 / 内边距 8 / 内层 20；缩略图 12 嵌在列表行内 |
| 概览只有一个高程卡 | 只有 `.status-card` 用 `--md-sys-elevation-level1`；isolation 由 CSS 里**没有通用 `.card` 类**来保证 |
| 状态不靠颜色 | 圆点永远配文字（`已连接`/`未连接`/`已暂停`），圆点 `aria-hidden` |
| 无渐变 / 无发光 / 无入场动画 | CSS 里没有任何 `gradient`、`filter`、`@keyframes`；`transition` 只用于交互反馈 |
| 动效 ≤ 200ms 且只在 `@media (hover: hover)` | 全部 `:hover` 规则都在 hover 媒体查询内；动效 token 只有 120/180ms |
| 正文列 640px | `--layout-content-max: 640px`，`.content` 居中 |
| 左 Rail / <840px 顶部 Tab | `@media (max-width: 839px)` |
| 可访问性 | 真 `<button>`/`<a>`，全局 `:focus-visible` 环，图标按钮全部有 `aria-label`，`role="switch"` + `aria-checked`，空状态有下一步动作，`prefers-reduced-motion` 生效 |

---

## 改这个页面时注意

- **不要**新增第二个带阴影的容器。需要强调就用层级（标题字重、`primary` 色、留白），
  不要用卡片。§6.3 明确把"SaaS 卡片套件"列为要避免的形态。
- **不要**在 `app.css` 之外写颜色。任何 `#rrggbb` 都应该先变成 `tokens.css` 里的角色。
- **不要**用 `24px` 做圆角。
- 新增视图：在 `js/views/` 加文件、在 `index.html` 的脚本清单里按依赖顺序加一行、
  在 `js/app.js` 的 `ROUTES` 里注册。
- 时间一律通过 `LinkOK.util` 格式化，不要在视图里自己 `new Date().toLocaleString()`，
  否则日期分组和相对时间会不一致。
