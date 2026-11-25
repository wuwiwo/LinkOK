# LinkOK 设计规范补充

> 本文件是 [SPEC.md](./SPEC.md) §6 的**补充**，不是替代。冲突时以 SPEC 为准。
>
> 内容来源（均注明许可）：
> - **A** — `frontend-design`，[anthropics/skills](https://github.com/anthropics/skills)，Apache-2.0，已作为技能安装
> - **B** — `better-ui`，[jakubkrehel/skills](https://github.com/jakubkrehel/skills)，MIT，**未**安装，知识提炼
> - **C** — `baseline-ui`，[ibelick/ui-skills](https://github.com/ibelick/ui-skills)，MIT，**未**安装，知识提炼
>
> 三份原文都是面向 **Web/CSS/Tailwind** 写的。下列条目已转译为 Material 3 + Compose 术语；
> 无法转译的直接标注为「不适用」，不假装能对上。

---

## 1. 反模板清单（来源 A）

AI 生成界面的典型痕迹。**这是本文件最有价值的部分**——它不是"要做什么"，而是"别长成什么样"。

| 痕迹 | LinkOK 的对应禁令 |
|---|---|
| 奶油底 `#F4F1EA` + 高对比衬线大标题 + 赭石色 `#D97757` 强调 | 禁止自造配色。**只用 M3 `ColorScheme` 角色色**（SPEC §6.1） |
| 近黑底 + 单一荧光绿/朱红强调 | 禁止。深色模式走 `dynamicDarkColorScheme` |
| 报纸式分栏、零圆角、密集竖线 | 禁止。用 M3 形状标度 |
| **SaaS 卡片套件**：内容切成一张张相同的圆角卡，所有层级共用一个圆角，同一个 `rgba(0,0,0,.1)` 阴影，再用渐变洗一遍当装饰 | **重点防范**。设置页只有 4 个分区，不该是 4 张一模一样的卡 |
| 模板化装饰：全大写小字眉标、`A · B · C` 中点串、`词 — 片段` 式标签、`#0B0B0B` 冒充纯黑、小数据用等宽字体、按钮文字尾随 `→` | 全部禁止 |

**判断规则**（来源 A 原文）：这些手法在某些场景是合法的，但它们是**默认值而非选择**。LinkOK 的默认值必须是 M3，任何偏离都要有理由。

---

## 2. 克制原则（来源 A）

- **"Spend your boldness in one place."** 全页只允许一个记忆点，其余保持安静。
- Chanel 法则：出门前照镜子，**摘掉一件配饰**。做完界面再看一遍，删掉一个装饰。
- 一次编排好的动效胜过满屏散布的效果。**每张卡片都加 hover 过渡 = AI 味**。
- 结构性元素（分隔线、编号、眉标）**必须承载信息**，不能是装饰。编号 `01/02/03` 只在内容真是序列时才用。

LinkOK 的"一个记忆点"定为：**手机端 Stash 的那张最新大图卡**。其余一律安静。

---

## 3. 同心圆角（来源 B，已转译）

```
outerRadius = innerRadius + padding + borderWidth
```

**Compose 写法**：

```kotlin
// 好：外圆角 = 内圆角 + 内边距
Surface(shape = RoundedCornerShape(16.dp)) {
    Box(Modifier.padding(8.dp)) {
        Surface(shape = RoundedCornerShape(8.dp)) { /* 16 - 8 = 8 */ }
    }
}

// 坏：内外同圆角，视觉上内层显得更方
Surface(shape = RoundedCornerShape(8.dp)) {
    Box(Modifier.padding(8.dp)) {
        Surface(shape = RoundedCornerShape(8.dp)) { }
    }
}
```

来源 B 的截断条件：内边距超过 `24px` 或刻意不对称时，两层视为独立表面，各用各的标度 token。

---

## 4. 高程与描边（来源 B，**已改变实现方式**）

来源 B 用三层 `box-shadow` 造"1px 环 + 抬升 + 环境光"。**Compose 没有 box-shadow**，等价物是 M3 的高程模型：

| 来源 B 的意图 | Compose/M3 的等价做法 |
|---|---|
| 浅色模式的 1px 环 | `Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)` |
| 抬升与阴影 | `Surface(tonalElevation = 1.dp)` — 靠**色调**而非投影表达层级 |
| 深色模式只留白色环 | 同上，`outlineVariant` 在深色下自动变成浅色低透明度 |
| `forced-colors` 下保底描边 | **不适用**。Android 无对应机制 |

**原则保留**：边框表达**结构**（分隔、选中），高程表达**层级**。不要用投影表达结构，也不要用边框表达层级。

---

## 5. 图片描边（来源 B，已转译）

图片在卡片里必须有一道极淡的内描边，否则浅色图会糊进背景。

```kotlin
// 用纯黑/纯白 + 10% 透明度，不要用带色调的中性色或强调色（边缘会泛色）
val outline = if (isSystemInDarkTheme())
    Color.White.copy(alpha = 0.10f)
else
    Color.Black.copy(alpha = 0.10f)

Image(
    painter = painter,
    contentDescription = null,
    modifier = Modifier
        .clip(RoundedCornerShape(12.dp))
        .border(1.dp, outline, RoundedCornerShape(12.dp)),  // 内描边
)
```

`Modifier.border` 绘制在边界内侧，不改变布局尺寸——与 CSS `outline` 的 `outline-offset: -1px` 意图一致。

---

## 6. 图标（来源 B，部分不适用）

**可用的部分**：

| 相邻文字字重 | 图标描边 |
|---|---|
| Regular 400，14–16sp | `1.5dp` |
| Medium/Semibold 500–600 | `2dp` |
| Bold 700 或独立强调图标 | `2.5dp` |

- 一个界面**只用一套图标库**。LinkOK 统一用 `androidx.compose.material.icons`。
- 图标尺寸取相邻字号的 `1em–1.25em`。
- **轮廓 = 默认态，实心 = 选中态**。Material Icons 的 `Outlined` / `Filled` 正好是一对待用变体。

**不适用的部分**：来源 B 假设图标库提供描边粗细参数（如 Lucide 的 `absoluteStrokeWidth`）。**Material Icons 是固定描边的矢量，没有这个参数**。因此：
- 不要为了凑字重去缩放图标（会糊）。
- 要强调时，用**尺寸或颜色**，不用描边粗细。

---

## 7. 数字与反馈时长（来源 C）

```kotlin
// 表格化数字：数据不要用比例数字，避免列宽跳动
TextStyle(fontFeatureSettings = "tnum")

// 交互反馈上限 200ms（来源 C：NEVER exceed 200ms）
tween(durationMillis = 200, easing = FastOutSlowInEasing)
```

**确认可用于 Compose**：`TextStyle` 确实有 `fontFeatureSettings` 字段，`"tnum"` 生效。

---

## 8. 动效约束（来源 C，已裁剪）

**保留为工程约束**：

- 只动 `transform` / `opacity`（Compose：`graphicsLayer` 的 `scaleX/scaleY/translationX/alpha`），**不要动布局属性**。
- 交互反馈 ≤ 200ms。
- 入场用 `ease-out`（Compose：`FastOutLinearInEasing` 或 `LinearOutSlowInEasing`）。
- 离屏的循环动画必须暂停。
- 不要自造缓动曲线。

**明确不适用**：

| 来源 C 的条目 | 原因 |
|---|---|
| `text-balance` / `text-pretty` | Compose **没有**这两项排版特性，Android 的换行由 `LineBreak` API 控制，粒度不同 |
| `h-dvh` 替代 `h-screen` | Web 视口单位问题，Compose 无对应 |
| `prefers-reduced-motion` | Android 无此媒体查询。等价物是 `Settings.Global.ANIMATOR_DURATION_SCALE`，需自行读取，**不保证被系统尊重** |
| `safe-area-inset` | Compose 用 `WindowInsets.safeDrawing` / `WindowInsets.systemBars` |
| `overscroll-behavior: contain` | Compose 无直接等价，滚动嵌套靠 `nestedScroll` 处理 |
| `@media (hover: hover)` | Android 无 hover 概念（除非鼠标/触控板外接） |

---

## 9. 文案规范（来源 A，直接采用）

这部分与平台无关，逐条生效：

- **从用户视角命名**。用用户能懂的话，不用系统实现的名词。（"管理通知"，不是"webhook 配置"）
- **主动语态**。按钮写清楚按下去会发生什么：`保存更改`，不是 `提交`。
- **动作名全流程一致**。按钮说"发布"，提示就得说"已发布"。（对应 LinkOK：按钮 `保存`，提示 `已保存到相册`）
- **错误不道歉、不含糊**。说清发生了什么、怎么修。
- **空状态是行动 invitación**，不是情绪。
- 句首大写、平实动词、无填充词，每个元素只干一件事。

**应用到 LinkOK 的具体文案**：

| 位置 | 用 | 不用 |
|---|---|---|
| Stash 保存按钮 | `保存` | `下载`、`导出` |
| 保存成功 | `已保存到相册` | `操作成功！` |
| Stash 空状态 | `还没有收到截图` + `在电脑上截图，它会出现在这里` | `暂无数据` |
| 连接状态 | `已连接` / `电脑未连接` | `在线`、`离线` |
| 无障碍被关 | `剪贴板同步已停止` + `前往设置重新开启` | `权限异常` |

---

## 10. 空状态与强调色（来源 C）

- **空状态必须有一个明确的下一步动作**。（SPEC §6.2 已按此设计）
- **一屏只用一个强调色**。M3 里对应 `primary`，`secondary`/`tertiary` 只用于极少数区分，不当装饰。
- **不用渐变做装饰**（来源 C：NEVER use gradients unless explicitly requested）。M3 本身也不用渐变。

---

## 11. 对 SPEC 的修订（**已采纳**）

读完三份技能后，对 SPEC 提了两处收紧。**两处均已落入 SPEC，本节保留决策记录。**

1. **§6.3 电脑设置页** —— 原写法"左侧导航 + 右侧 M3 卡片"踩中来源 A 的"SaaS 卡片套件"痕迹。**已改**为：概览区用一个 `28dp` 主卡片承载连接状态，本次传输与最近一张走扁平 `ListItem`，历史/设备/设置三个分区**全部**用列表行，不再有成排的等权卡片。
2. **§6.1 形状与同心圆角** —— 原写法只有"卡片 16dp、大图卡 24dp、按钮 full-round"，既缺同心关系，`24dp` 也不在 M3 标度上。**已改**为：形状标度表（只用 `4/8/12/16/20/28/full`）+ 同心公式 + 三组按标度推出的组合 + 超过 24dp 内边距的例外。

### review 中额外发现并已修复的一处

原设计用**绿色圆点**表示"已连接"。两个问题：

- M3 **没有 success 语义角色**，自造绿色就是本文件 §1 禁止的 bespoke palette。
- **只靠颜色传达状态**，色盲用户无法分辨。

**已改为**：圆点用 M3 角色色（`primary` / `outline`），且**旁边必须有文字**（`已连接` / `未连接`）。这条已写进 SPEC §6.1 作为硬约束。

### 尚未采纳的一条

本文件 §7 建议对数据使用 `tabular-nums`（`TextStyle(fontFeatureSettings = "tnum")`）。这是一条 Web 端的排版技巧，在 Compose 中可用但价值有限——LinkOK 的数字（传输张数、端口、时间）都不在会跳动的表格列里。**暂不要求**，实现时若发现数字宽度抖动再补。
