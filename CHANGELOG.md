# Changelog

LinkOK 由两端组成，**版本号与变更记录各自独立**：

| 端 | 版本来源 | 变更记录 | 发版命令 |
|---|---|---|---|
| **电脑端**<br>Node Hub / C# 原生桥 / 设置页 | [`version.config`](version.config) | [CHANGELOG-PC.md](CHANGELOG-PC.md) | `.\scripts\release-pc.ps1 -Minor\|-Patch "标题"` |
| **手机 App**<br>Kotlin / Compose / Material 3 | [`android/version.config`](android/version.config) | [CHANGELOG-ANDROID.md](CHANGELOG-ANDROID.md) | `.\scripts\release-android.ps1 -Minor\|-Patch "标题"` |

两端独立演进的理由：一次改动通常只影响一端，共用一个号会让另一端
"看起来也升级了"，无法判断实际部署的是哪个版本。

## 版本规则

开发阶段统一用 `0.MINOR.PATCH`：

| 场景 | 动作 |
|---|---|
| 功能变更 / 修复重大问题 | MINOR +1，PATCH 归零 |
| 小 bug / 文档 / 小改进 | PATCH +1 |

发版脚本会一并完成：递增版本文件 → 同步 `pc/package.json`（仅 PC 端）→
在对应的 CHANGELOG 插入条目 → `git commit` → `git push`。

## 当前版本

- 电脑端：见 [`version.config`](version.config)，运行时访问
  `http://127.0.0.1:8787/health` 也能看到
- 手机 App：见 [`android/version.config`](android/version.config)，
  App 的**欢迎页 / 配对页 / 设置页底部**会显示形如
  `开发版 0.3.2-1126-1030-debug`（语义版本 + 构建时间）

## 历史

v0.1 ~ v0.3.2 期间两端共用同一个版本号，相关内容已按实际归属拆到上述两份文件：

- 电脑端：[CHANGELOG-PC.md](CHANGELOG-PC.md)
- 手机 App：[CHANGELOG-ANDROID.md](CHANGELOG-ANDROID.md)
