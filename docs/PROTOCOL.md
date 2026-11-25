# LinkOK 共享约定（实现者必读）

> 本文件是**跨端契约**。Node Hub、C# helper、Android App、设置页四方都依赖同一份定义。
> 与 [SPEC.md](./SPEC.md) 冲突时以 SPEC 为准；SPEC 未覆盖的细节以本文件为准。
> 术语以 [CONTEXT.md](../CONTEXT.md) 为准。

---

## 1. 端口与地址

| 用途 | 端口 | 协议 |
|---|---|---|
| Hub HTTP + WebSocket | **8787** | `http://`（局域网，无 TLS） |
| UDP 重发现 | **8788** | 广播 |

- 绑定点：Hub 必须绑 `0.0.0.0`，不能只绑 `127.0.0.1`，否则手机连不上。
- 设置页自身也走 8787，`GET /` 返回静态页。

---

## 2. 鉴权

```
Authorization: Bearer <token>
```

- 免除鉴权的端点**只有三个**：`GET /health`、`POST /pair`、`GET /`（静态页外壳）。
- 其余一律 401：`{"error":"unauthorized"}`。
- Token 是 32 字节随机数的 base64url，长期有效，重新配对才失效。
- 对比 Token 时用**恒定时间比较**，不要用 `===`。

---

## 3. HTTP 端点

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/health` | 否 | — | `{ok:true, version:"0.1.0", paired:bool}` |
| POST | `/pair` | 否 | `{code, deviceName, deviceModel}` | `{token}` / 400 / 401 |
| GET | `/api/state` | 是 | — | `{config, connection:{connected, deviceName, since}}` |
| PATCH | `/api/config` | 是 | 配置片段 | 完整配置 |
| GET | `/api/history?from=&to=&limit=` | 是 | — | `{items:[HistoryItem]}` |
| GET | `/api/history/:id/raw` | 是 | — | 图片二进制 |
| DELETE | `/api/history/:id` | 是 | — | `{ok:true}` |
| POST | `/api/pairing-code` | 是 | — | `{code, expiresAt, qrPayload}` |
| POST | `/api/device/revoke` | 是 | — | `{ok:true}` |

### 状态码约定

| 码 | 含义 |
|---|---|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | Token 无效 / 配对码错误或过期 |
| 404 | 资源不存在 |
| 413 | 图片超过 20MB |
| 500 | 内部错误 |

错误体统一 `{"error":"<machine_readable>", "message":"<人类可读中文>"}`。

---

## 4. HistoryItem（历史条目）

```jsonc
{
  "id": "20261125T164651132-3f2a1b",   // wxyz 时用 UTC，不能用冒号
  "sha256": "3f2a1b…",                  // 小写 hex，64 字符
  "source": "phone",                    // phone | pc-clipboard | pc-folder
  "arrivedAt": "2026-11-25T16:46:51.132+08:00",
  "file": "2026-11-25/20261125T164651132-3f2a1b.png",  // 相对 history 根
  "bytes": 482133,
  "width": 1080,
  "height": 2400
}
```

**id 规则**：`arrivedAt` 的 UTC 紧凑形式（去掉 `-`、`:`、`.`）`-` 哈希前 6 位。**不含冒号**，因为要用于文件路径和 URL。

---

## 5. WebSocket 协议

连接：`ws://<host>:8787/ws`，握手时带 `Authorization: Bearer <token>`。
握手失败返回 401，**不带** `Sec-WebSocket-Accept`。

### 5.1 消息信封

所有控制帧是 **UTF-8 JSON 文本帧**，必有 `type` 字段。二进制帧只用于图像本体，**不带**类型标识，靠"前一条 `capture` 声明"关联。

### 5.2 上行（手机 → Hub）

```jsonc
{"type":"hello","deviceName":"Redmi K50","deviceModel":"M2012K11AC","protocolVersion":1}

{"type":"capture","id":"…","sha256":"…","arrivedAt":"…","mime":"image/png","bytes":482133}
// ↓ 紧接着一个二进制帧（图像本体）

{"type":"clipboard","text":"…","sha256":"…"}
{"type":"ack","id":"…"}          // 确认已收到某个捕获
{"type":"ping"}
```

### 5.3 下行（Hub → 手机）

```jsonc
{"type":"hello-ok","protocolVersion":1}

{"type":"capture","id":"…","sha256":"…","arrivedAt":"…","mime":"image/png","bytes":482133}
// ↓ 紧接着一个二进制帧

{"type":"clipboard","text":"…","sha256":"…"}
{"type":"capture-result","id":"…","ok":true}   // 手机侧接收确认
{"type":"pong"}
```

### 5.4 分帧

- 二进制帧 ≤ 1MB 时一次发完。
- **> 1MB 时按 256KB 切片**，每帧前导一个 JSON 文本帧：

```jsonc
{"type":"chunk","id":"…","seq":0,"total":3}
```

- 接收端按 `seq` 重组，`seq` 从 0 开始，缺片则整条丢弃并发 `{"type":"capture-result","ok":false,"reason":"incomplete"}`。

### 5.5 心跳

- 手机每 **20s** 发一次 `ping`，Hub 回 `pong`。
- Hub 侧 **45s** 收不到任何帧即判定断开，关闭连接。
- 重连退避：1s → 2s → 4s → 8s → 16s → 30s（上限）。

### 5.6 Echo 抑制（**硬不变量**）

两端各自维护"最近一次自己写入的文本哈希"。收到 `clipboard` 时：

1. 计算 `sha256(text)`
2. 若等于自己最近写入的哈希 → **丢弃，不回传**
3. 否则写入本机剪贴板，并记录该哈希

**违反这条会导致两台设备相互覆盖剪贴板，形成死循环。**

---

## 6. 配对与发现

### 6.1 二维码载荷

```
linkok://pair?host=192.168.1.100&port=8787&code=AB12CD&fp=<token 的 sha256 前 16 位>
```

- `code` 是 6 位大写字母数字，**有效期 120 秒**，用后即焚，失败 5 次锁定 5 分钟。
- `fp` 用于手机端识别"是不是同一个 Hub"，避免换机后误连。

### 6.2 UDP 重发现

- 手机广播到 `255.255.255.255:8788`，载荷：

```jsonc
{"type":"linkok-discover","fp":"<fp>"}
```

- Hub 收到后若 `fp` 匹配，**单播**回应：

```jsonc
{"type":"linkok-here","host":"192.168.1.100","port":8787}
```

- 手机收到后用它更新地址并重连。**Token 不变**，无需重新配对。
- 广播间隔：1s、2s、4s、5s（上限 5s），最多尝试 30 秒。

---

## 7. 配置对象

```jsonc
{
  "port": 8787,
  "retentionDays": 30,          // 7 | 15 | 30 | 0（0 = 永不）
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

- `retentionDays: 0` 表示永不清理。**其他值只允许 7/15/30**，非法值回 400。
- `screenshotDir` 为空时，Hub 启动时从注册表 `User Shell Folders\{374DE290-123F-4565-9164-39C4925E467B}` 动态解析。

---

## 8. 存储布局

### 8.1 PC

```
%LOCALAPPDATA%\LinkOK\
├── config.json
├── history\
│   ├── index.json
│   └── 2026-11-25\
│       └── 20261125T164651132-3f2a1b.png
└── logs\
    └── hub-2026-11-25.log
```

`index.json` 结构：

```jsonc
{"version":1, "items": [HistoryItem]}
```

**写 index.json 必须原子**：写 `index.json.tmp` → `fsync` → `rename`。不要直接覆盖。

### 8.2 手机

```
/data/data/<pkg>/
├── files\stash\          # 未保存的 Capture
│   └── <id>.png
└── datastore\stash.preferences_pb
```

Stash 索引存 DataStore，结构同 PC 但 `savedAt` 字段用于标记已保存（正常流程下 Save 后即移除，该字段仅用于崩溃恢复）。

---

## 9. 图片规则

- **统一 PNG**。手机端由 Android 直接产出 PNG；PC 端剪贴板图片（`CF_DIB`/`CF_BITMAP`）由 C# helper 转 PNG 再交给 Node。
- 单张上限 **20MB**，超限：Hub 回 413，手机端 toast `截图过大，未发送`。
- 哈希：**SHA-256 全文件内容**，小写 hex。去重就是比这个值。
- 尺寸记录 `width`/`height`，由发送端填。

---

## 10. 保留期（Retention）

- 计时基准：**Arrival Time**，不是图片自身时间。
- 执行：每小时一次 + 启动时一次。
- 范围：**只删 LinkOK 自己创建的副本**（手机 Stash、PC History）。
- 手机 Stash 额外约束：总量超过 **500MB** 时，从最旧的开始删，直到低于上限。这条**独立于** `retentionDays`，即使设为"永不"也生效。

---

## 11. C# helper ↔ Node 的 stdio 协议

**换行分隔的 JSON**，一行一条消息，UTF-8，不转义中文。

### Node → helper

```jsonc
{"cmd":"start"}
{"cmd":"set-paused","paused":true}
{"cmd":"show-qr","payload":"linkok://pair?…"}
{"cmd":"hide-qr"}
{"cmd":"notify","title":"…","body":"…","thumbFile":"C:\\…\\x.png"}
{"cmd":"set-tray-state","state":"connected|disconnected|paused","device":"Redmi K50"}
{"cmd":"quit"}
```

**补充（实现后追加）**：原 §11 漏了「Hub 把内容写到 Windows 剪贴板」这条命令，而
SPEC §5.1（手机 Capture → 电脑剪贴板）与 §5.4（剪贴板同步）都依赖它。已新增：

```jsonc
{"cmd":"set-clipboard-image","file":"C:\\…\\x.png"}
{"cmd":"set-clipboard-text","text":"…"}
```

写剪贴板不产生 `clipboard-*` 事件 —— helper 在写入**之前**就 arm 了 echo 守卫
（见 §5.6），所以绝不会把自己的写入当成用户复制回传。

### helper → Node

```jsonc
{"evt":"ready","version":"0.1.0"}
{"evt":"clipboard-image","file":"C:\\…\\clip-<hash>.png","sha256":"…","width":1080,"height":2400}
{"evt":"clipboard-text","text":"…","sha256":"…","chars":42,"truncated":false}
{"evt":"file-captured","file":"E:\\download\\x.png","sha256":"…","width":…,"height":…,"name":"x.png"}
{"evt":"tray-click","item":"pair|settings|pause|autostart|quit"}
{"evt":"error","code":"…","message":"…"}
```

`tray-click` 的 `pause` 项会带 `"enabled":true|false` 表示暂停后的目标状态。

已定义的错误码：`internal`、`bad-json`、`tray-unavailable`、`notify-unavailable`、
`thumb-missing`、`thumb-too-large`、`qr-too-long`、`log-path-unavailable`。

- helper **不得**直接访问网络，它与 Hub 的连接只有 stdio。
- Node 必须容忍 helper 崩溃并重启它；重启间隔指数退避至上限 5s，
  **连续失败不放弃**（降级为慢速重试并记一条 error，避免瞬时故障导致永久瘫痪）。
- 剪贴板图片由 helper **落盘到临时目录**再告知路径，不通过 stdio 传二进制。
- **临时目录必须可写**。解析顺序：`LINKOK_HELPER_TMP` → `<LINKOK_DATA_DIR>\tmp`
  → `%LOCALAPPDATA%\LinkOK\tmp` → `%TEMP%\LinkOK`，第一个通过真实写探测的胜出。
  全失败则在发出 `ready` **之前**抛出带指引的异常 —— Hub 应展示这条信息，
  而不是无视它做无头重试。

---

## 12. 并发与顺序保证

- 同一时刻**只允许一条** WebSocket 连接。新连接接入时，旧连接被关闭（`1000` 正常关闭）。
- Capture 的投递**必须串行**：上一条的 `capture-result` 到达（或 10s 超时）后才发下一条。
- 剪贴板消息不排队，**后到者胜**，直接覆盖待发缓冲区。

---

## 13. 时区与时间格式

- 所有时间戳是 **ISO 8601 带偏移**：`2026-11-25T16:46:51.132+08:00`。
- 内部计算用 UTC，展示用本机时区。
- **id 里不能有冒号**（会破坏文件路径与 URL）。

---

## 14. 验收自检清单

实现完一块后，逐条自问：

- [ ] 未带 Token 的请求是否都返回 401？
- [ ] 重复的图片是否只投递一次？
- [ ] 自己写入剪贴板的内容是否会回传？（必须不会）
- [ ] index.json 断电时会不会损坏？（必须原子写）
- [ ] 手机不在线时 PC 截图会不会堆积阻塞？
- [ ] 断开重连后 Token 是否仍然有效？
- [ ] 保留期为"永不"时，Stash 的 500MB 上限是否仍生效？
- [ ] 20MB 以上的图是否被拒绝而不是崩溃？
