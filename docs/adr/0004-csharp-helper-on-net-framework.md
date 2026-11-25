# 0004 — C# helper on .NET Framework 4.8, not .NET SDK

## Status

Accepted

## Context

The Hub needs two Windows capabilities that Node cannot provide directly:

1. **Clipboard image observation.** Polling is lossy and wasteful; the correct API is `AddClipboardFormatListener` plus a `WM_CLIPBOARDUPDATE` message pump. Node has no message pump and no clipboard format access.
2. **A tray icon with a context menu.** `Shell_NotifyIcon` again requires a window procedure and a message loop.

Three options were considered:

1. A Node native addon (`node-gyp`) calling Win32 directly.
2. A separate C# process, bridged over stdio.
3. Polling from Node with no native code at all.

Option 3 was rejected on correctness: polling a clipboard misses content that changes between polls, and polling a screenshot folder is already handled separately.

Option 1 was rejected on build fragility: it needs a C++ toolchain (MSVC) that is not on this machine, and native addons break on every Node major upgrade.

Option 2 was chosen. It then needed a compiler.

## Decision

The helper is a **C# program targeting .NET Framework 4.8**, compiled with the compiler that ships inside Windows: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

This machine was measured to have:

- **No .NET SDK** — `C:\Program Files\dotnet\sdk` does not exist, so `dotnet build` is unavailable.
- **Runtime only** — `Microsoft.NETCore.App` 6.0.36 and 8.0.34, which execute but do not compile.
- **.NET Framework 4.8.10008**, which includes `csc.exe` v14.8.10001.

A probe containing `NotifyIcon`, `System.Drawing.Bitmap`, and P/Invoke declarations was compiled and run successfully, confirming the path works.

The helper and the Hub exchange newline-delimited JSON over stdio. The Hub spawns the helper as a child process and restarts it if it exits.

## Consequences

- **No download, no install, no MSVC.** The build works on this machine today and on any Windows with .NET Framework 4.8, which is every supported Windows 10/11.
- The helper is limited to .NET Framework 4.8 APIs. `System.Text.Json` is unavailable, so the stdio protocol uses a small hand-rolled JSON writer or `JavaScriptSerializer`. This is acceptable because the messages are a handful of fixed shapes.
- Long-lived process boundaries need supervision: the Hub must detect helper death and restart it, and must not block on stdio reads.
- `csc` reference paths contain spaces (`Program Files`), so every `/reference:` argument must be quoted; unquoted paths are split and produce `CS2005` (this was hit during the probe).
- Building against Framework 4.8 means the helper executable is not self-contained, but Framework 4.8 is an in-box component on this OS version.
- If the machine is later given a .NET SDK, the helper can migrate to .NET 8 with no change to the stdio protocol.
