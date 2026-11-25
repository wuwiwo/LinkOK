# LinkOK Windows native helper (C#)

The Windows side of LinkOK that Node cannot do: clipboard observation, the screenshot
folder watcher, the Tray, the pairing QR window, and Windows notifications.

It is a **single Windows executable** built from the C# sources in this directory with the
compiler that ships inside Windows. There is no .NET SDK on this machine, no NuGet, and no
package restore. See [SPEC §3.1.1](../docs/SPEC.md) and
[ADR 0004](../docs/adr/0004-csharp-helper-on-net-framework.md).

- **Target:** .NET Framework 4.8, `winexe` (no console window)
- **Talks to:** the Hub only, over stdin/stdout. It never touches the network.
- **Contract:** [PROTOCOL.md §11](../docs/PROTOCOL.md), extended as documented below.

---

## Build

```powershell
. <项目根>\scripts\env.ps1
$r = Build-Helper
$r.ExitCode; $r.StdOut; $r.StdErr
```

`Build-Helper` globs `pc/helper/*.cs` (recursively), so `test/` deliberately contains no
`.cs` file; the integration probe is `test/HelperProbe.cs.txt`.

The script invokes `csc.exe` through `Start-Process` with file redirection, because this
environment forbids a child process from capturing another program's stdio through a pipe
(`EPERM` on `\\.\pipe\...`). Two consequences worth knowing if you change it:

- Every `/reference:` path contains spaces and **must stay quoted**, or `csc` splits it and
  fails with `CS2005`.
- Redirect with files, not `|` or `>`.

Output: `pc/helper/linkok-helper.exe`.

### Compiling by hand

```powershell
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$src = Get-ChildItem <项目根>\pc\helper -Filter *.cs | % { $_.FullName }
$args = @('/nologo','/target:winexe','/optimize+',
          ('/out:"<项目根>\pc\helper\linkok-helper.exe"'),
          ('/reference:"{0}\System.Windows.Forms.dll"' -f $fw),
          ('/reference:"{0}\System.Drawing.dll"' -f $fw),
          ('/reference:"{0}\System.dll"' -f $fw),
          ('/reference:"{0}\System.Core.dll"' -f $fw)) + $src
Start-Process "$fw\csc.exe" -ArgumentList $args -Wait -NoNewWindow
```

Only Framework 4.8 APIs are available. In particular **`System.Text.Json` does not exist
here** — JSON is hand-rolled in `Json.cs` and `System.Web.Extensions` is not referenced.

The build currently produces **zero errors and zero warnings**.

---

## Running it

The helper is meant to be spawned by the Hub:

```
helper.exe  with  stdin/stdout/stderr = pipes
```

It reacts to messages on stdin and writes events to stdout. It exits when stdin closes.

Standalone debugging is allowed — the environment variables below make it behave:

| Variable | Purpose |
|---|---|
| `LINKOK_HELPER_TMP` | Directory for clipboard image spills. **Set by the Hub** to `<dataDir>/tmp`. |
| `LINKOK_DATA_DIR` | Fallback source for `<dataDir>/tmp` when `LINKOK_HELPER_TMP` is unset. |
| `LINKOK_SCREENSHOT_DIR` | Overrides the registry screenshot folder. Used by the tests. |
| `LINKOK_HELPER_LOG` | Explicit log file path. Default `%LOCALAPPDATA%\LinkOK\logs\helper-YYYY-MM-DD.log`. |

Diagnostics go to **stderr and the log file, never stdout** — stdout carries protocol lines
only. If the log file cannot be created the helper keeps running and says so on stderr once.

### Single instance

A named mutex (`Local\LinkOK.Helper.SingleInstance`) guards the process. A second launch
prints a message on stderr and exits with **code 2**. The Hub should treat that as "already
running", not as a crash, and must not retry in a loop.

---

## The stdio protocol

Newline-delimited JSON, one object per line, **UTF-8 without BOM**, Chinese never escaped,
terminator `\n`. Blank lines are ignored. A malformed line is reported and skipped; the
process keeps running.

### Node → helper

| Command | Fields | Effect |
|---|---|---|
| `start` | — | Starts the clipboard listener and screenshot watcher. Idempotent. Emits `ready` **once per process**. |
| `set-paused` | `paused` (bool) | While paused, clipboard captures are not emitted. The folder watcher keeps running. |
| `show-qr` | `payload` (string) | Shows the topmost QR window, encoded by the helper. |
| `hide-qr` | — | Hides the QR window. *(extension)* |
| `notify` | `title`, `body`, `thumbFile` (optional) | Windows notification; `thumbFile` becomes the toast icon. |
| `set-tray-state` | `state`: `connected` \| `disconnected` \| `paused`, `device` (optional) | Redraws the tray icon and status line. |
| `set-clipboard-image` | `file` | Writes a PNG to the Windows clipboard. *(extension — see below)* |
| `set-clipboard-text` | `text` | Writes text to the Windows clipboard. *(extension — see below)* |
| `quit` | — | Emits `tray-click quit`, then exits with code 0. |

### helper → Node

| Event | Fields |
|---|---|
| `ready` | `version` |
| `clipboard-image` | `file`, `sha256`, `width`, `height`, `bytes` |
| `clipboard-text` | `text`, `sha256`, `chars`, `truncated` |
| `file-captured` | `file`, `sha256`, `width`, `height`, `bytes`, `name` |
| `tray-click` | `item`: `pair` \| `settings` \| `pause` \| `autostart` \| `quit`, plus `enabled` (bool) for `pause` and `autostart` |
| `error` | `code`, `message` (Chinese, human-readable) |

`sha256` is always lowercase hex of exactly what was emitted. For `clipboard-text` it is the
hash of the **truncated** text the Hub receives. `width`/`height` are always present on
`clipboard-image` and `file-captured`; `bytes`, `chars`, `truncated`, `name` are additive.

### Error codes

| Code | Meaning |
|---|---|
| `clipboard-busy` | Another app held the clipboard through all retries; nothing was read. |
| `clipboard-write-failed` | `set-clipboard-*` could not write. |
| `file-missing` | `set-clipboard-image` target does not exist / is unreadable. |
| `thumb-missing`, `thumb-decode` | Notification thumbnail unusable; the toast still shows. |
| `qr-too-long` | Payload exceeds the encoder; the window shows text instead. |
| `notify-unavailable`, `tray-unavailable` | No interactive desktop/shell; the rest keeps working. |
| `clipboard-unavailable` | `AddClipboardFormatListener` failed. |
| `bad-json`, `bad-command` | That line was rejected; the loop continues. |
| `internal` | Unexpected failure, logged with a stack-free description. |

No command that can fail exits the process.

---

## Behaviour notes

### Clipboard (SPEC §5.2, §5.4)

Listens with `AddClipboardFormatListener` on a message-only (`HWND_MESSAGE`) window, so
`WM_CLIPBOARDUPDATE` arrives instead of polling. Read order: **PNG → CF_DIBV5 → CF_DIB →
CF_BITMAP**, then text.

`CF_BITMAP` matters in practice: some apps (WeChat among them) publish only a bitmap, which
`System.Drawing` cannot take directly, and `System.Drawing` cannot consume a raw DIB either
(only a `.bmp` *file*, which has a 14-byte header in front). `DibDecoder.cs` therefore parses
DIB headers itself: `BITMAPCOREHEADER`/`INFO`/`V4`/`V5`, 1/4/8/16/24/32 bpp, `BI_RGB` and
`BI_BITFIELDS`, bottom-up and top-down rows, and truncated pixel data.

Clipboard images are **written to a temp PNG and reported by path** (PROTOCOL §11: never
binary over stdio). Text is capped at **64 KB** and truncated on a character boundary
(surrogate pairs are never split); `truncated:true` says it happened.

The clipboard is a single global lock. Every read is retried up to 10 times with a short
delay; if it still fails the helper emits `clipboard-busy` and moves on rather than hanging.

### Echo suppression (SPEC §4 invariant 1 / PROTOCOL §5.6)

The helper never reports content it wrote itself. Both guards are armed **before** the write
is performed, because `WM_CLIPBOARDUPDATE` is delivered on the very next pump iteration and
the reader thread can otherwise win the race:

1. **Hash guard** — the sha256 of the exact text / PNG bytes written. One-shot.
2. **Positional guard** — the next clipboard update after a write, used when the read-back
   bytes cannot be predicted (an app may re-encode the DIB on the way through).

`set-clipboard-*` therefore emits **no** `clipboard-image` / `clipboard-text` event at all,
so the Hub never has to filter them. If a write fails the guards are disarmed again.

Additionally, the folder watcher ignores anything under the helper's own temp directory, so
a clipboard spill can never be reported back as a `file-captured`.

### Screenshot folder (SPEC §5.2)

`FileSystemWatcher` on the folder resolved from
`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
value `{374DE290-123F-4565-9164-39C4925E467B}`, then environment-expanded (OneDrive
frequently redirects it; this machine resolves to `E:\download`). `LINKOK_SCREENSHOT_DIR`
overrides it.

Files are debounced: a candidate is hashed only after its size and write time have been
quiet for 350 ms, because screenshot tools create the file and then write it in chunks. A
file that never settles is abandoned after 20 s with `file-unstable`. Files already present
when the helper starts are also queued (last 10 minutes), so a capture saved while LinkOK was
down is not lost — the Hub's SHA-256 dedupe makes that harmless. Identical bytes are emitted
at most once. Images up to 20 MB are delivered; larger ones are reported as `file-too-large`.

### Tray (SPEC §5.8)

Native `Shell_NotifyIcon` with a `ContextMenuStrip` popup. Menu: a non-clickable status
line, 打开设置, 配对新设备, 暂停同步, 开机自启 (checkable), 退出.

The helper does not own the Hub, so those three items emit `tray-click` for the Hub to act
on. Two exceptions are handled in-process: **退出** quits, and **开机自启** writes/removes
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LinkOK` and reports the result as
`tray-click autostart enabled:<bool>`.

Icons are drawn in code (`TrayArt.cs`) — no image files: connected (blue link), disconnected
(grey link), paused (grey link with a red slash).

`NotifyIcon` was deliberately not used: a notification with a thumbnail needs
`NIF_INFO | NIIF_USER | hBalloonIcon`, which `System.Windows.Forms.NotifyIcon` does not
expose.

If the icon cannot be created (no interactive desktop — e.g. the Hub hosted as a Windows
service in session 0) the helper emits `tray-unavailable`, **keeps running**, and everything
else still works. `notify` then fails with `notify-unavailable`; the thumbnail path is still
validated first, so a bad path is reported as `thumb-missing` either way.

### QR window (SPEC §5.5)

Topmost, fixed-size, closable, re-shown on each `show-qr`, dismissed with Esc. The QR is
encoded by `QrCode.cs` — a self-contained byte-mode QR Model 2 encoder (versions 1–10,
error-correction level M, all eight masks with standard penalty scoring, Reed–Solomon over
GF(256), short/long block interleaving). No NuGet, no external file, no npm.

Capacity at EC level M is ~213 bytes; a real `linkok://pair?...` payload is ~73 bytes and
encodes to version 5. Past the limit the window shows the payload as text with a note and the
helper emits `qr-too-long`.

---

## Protocol additions beyond PROTOCOL §11

`PROTOCOL.md` §11 has no command for the Hub to **write** the Windows clipboard, but
SPEC §5.1 (a Phone Capture must land on the PC clipboard) and SPEC §5.4 (PC → Phone text
must be written to the PC clipboard) require one. Two commands were added, agreed with the
Hub:

```jsonc
{"cmd":"set-clipboard-image","file":"<用户目录>\\AppData\\Local\\LinkOK\\history\\2026-11-25\\x.png"}
{"cmd":"set-clipboard-text","text":"…"}
```

And one convenience command, `hide-qr`.

Events also gained additive fields (`bytes`, `chars`, `truncated`, `name`, `enabled`) and
`set-tray-state` accepts an optional `device`. All are ignorable by a §11-only consumer.

---

## Testing

`test/HelperProbe.cs.txt` is an integration probe that drives the real executable over real
anonymous pipes (the sandbox blocks `Process.Start` redirection, so it uses `CreateProcess`
with inherited handles) and asserts against real Windows clipboard state.

```powershell
# compile the probe together with the helper sources (it calls QrCode directly)
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$src = Get-ChildItem <项目根>\pc\helper -Filter *.cs | % { $_.FullName }
Copy-Item <项目根>\pc\helper\test\HelperProbe.cs.txt $env:TEMP\LinkOKProbe.cs
$args = @('/nologo','/target:exe','/main:LinkOK.Probe.Program',
          ('/out:"<项目根>\pc\helper\test\linkok-probe.exe"'),
          ('/reference:"{0}\System.Windows.Forms.dll"' -f $fw),
          ('/reference:"{0}\System.Drawing.dll"' -f $fw),
          ('/reference:"{0}\System.dll"' -f $fw),
          ('/reference:"{0}\System.Core.dll"' -f $fw)) + $src + "$env:TEMP\LinkOKProbe.cs"
Start-Process "$fw\csc.exe" -ArgumentList $args -Wait -NoNewWindow

# then:
.\test\linkok-probe.exe                     # 27 protocol/clipboard/watcher/tray assertions
.\test\linkok-probe.exe --single-instance   # mutex guard
.\test\linkok-probe.exe --dump-qr <payload> <out.png>   # encoder matrix + PNG, for a decoder
.\test\linkok-probe.exe --qr-render         # render the real QrForm to a PNG
.\test\linkok-probe.exe --qr-window         # launch the helper, show QR, capture the window
```

`harness.ps1` is an older PowerShell driver kept for reference; it cannot work in this
sandbox because it uses `Process.Start` redirection, which is blocked.

The QR encoder was verified against an **independent decoder** (`jsqr` from npm, used only
for verification, never by the helper): every version 1–10, including v8/v10 which exercise
short-block interleaving, plus UTF-8 payloads, round-tripped exactly.

---

## Known limitations

1. **Tray and notifications require an interactive desktop session.** Under a service or
   session-0 host, `Shell_NotifyIcon` fails with `win32=5` (access denied). The helper
   degrades: it reports `tray-unavailable` and keeps serving clipboard and screenshot
   events. Everything else is unaffected. This was observed during development because the
   test session has no shell.
2. **QR capacity is ~213 bytes at EC level M** (versions 1–10 only). Enough for the pairing
   payload; longer content degrades to text plus `qr-too-long`. Error-correction level H and
   versions 11+ are not implemented, and there is no Kanji/alphanumeric mode.
3. **The temp directory must be writable.** The helper probes candidates in order
   (`LINKOK_HELPER_TMP` → `LINKOK_DATA_DIR\tmp` → `%LOCALAPPDATA%\LinkOK\tmp` → `%TEMP%\LinkOK`)
   and logs which one it used. If none is writable it fails **before** emitting `ready`, with
   a message naming the variable to set — the Hub should surface that instead of retrying
   blindly.
4. **Paused only stops clipboard captures.** The folder watcher keeps running so screenshots
   are not lost; the Hub decides what to forward.
5. **Text-only untiled clipboard is not supported**: only `CF_UNICODETEXT`/`CF_TEXT`. Rich
   text/HTML is out of scope (SPEC §2.2).
6. **Monitor/DPI changes** do not rescale the tray icon (Windows scales it).
7. **Single user, single session.** The mutex is per-session (`Local\`), which is intended.

---

## Source map

| File | Responsibility |
|---|---|
| `Program.cs` | Entry point, stdin loop, stdout serialization, mutex, ready emission. |
| `HelperRuntime.cs` | Owns monitors/tray/QR, marshals commands onto the UI thread. |
| `Clipboard.cs` | Raw Win32 clipboard read/write, retries, 64 KB text cap, DIB→PNG. |
| `ClipboardMonitor.cs` | Worker thread, echo suppression, duplicate suppression, spill to temp. |
| `DibDecoder.cs` | CF_DIB / CF_DIBV5 → `Bitmap` for every common header and bit depth. |
| `FolderWatcher.cs` | Screenshot folder watcher, debounce/settle, registry exclusion. |
| `Tray.cs` | `Shell_NotifyIcon`, menu, icon states, balloon with thumbnail, autostart. |
| `TrayArt.cs` | Icon artwork drawn with `System.Drawing`. |
| `QrCode.cs` | Self-contained QR Model 2 encoder (byte mode, EC level M). |
| `QrWindow.cs` | The pairing window. |
| `Json.cs` | Minimal JSON reader/writer (no BOM, Chinese unescaped). |
| `Log.cs` | Log file, exception descriptions, screenshot/temp directory resolution. |
| `ImageIO.cs` | PNG encode/decode, sha256, DIB construction for clipboard writes. |
| `Native.cs` | P/Invoke, message-only window, `NOTIFYICONDATA`. |
