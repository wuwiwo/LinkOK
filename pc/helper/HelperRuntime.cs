// LinkOK helper — ownership of the monitors, tray and QR window.
//
// Every command that crosses a thread boundary marshals onto the UI thread, because the
// clipboard owner handle, the tray window and the QR form all live there. Worker threads
// never touch WinForms or window handles directly.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace LinkOK.Helper
{
    internal sealed class HelperRuntime
    {
        /// <summary>Managed id of the thread that owns every window and the message loop.</summary>
        private static int _uiThreadId;

        private readonly List<string> _started = new List<string>();

        private MessageWindow _clipboardWindow;
        private ClipboardMonitor _clipboard;
        private FolderWatcher _folderWatcher;
        private TrayIcon _tray;
        private QrForm _qrForm;
        private string _tempDir;

        private volatile bool _startedMonitors;
        private volatile bool _paused;
        private volatile bool _shuttingDown;
        private string _screenshotDir;

        public void Start()
        {
            // Every window below (message-only listener, tray, QR form) is created on this
            // thread, so this is the thread that must run the message loop.
            _uiThreadId = Thread.CurrentThread.ManagedThreadId;
            HiddenInvoker.Initialize();

            _tempDir = Paths.EnsureTempDir();
            _screenshotDir = Paths.ResolveScreenshotDir();

            // The message-only window is created here (UI thread) so AddClipboardFormatListener
            // and the message pump live on the same thread.
            _clipboardWindow = new MessageWindow();
            _clipboardWindow.ClipboardUpdate += OnClipboardUpdate;

            _clipboard = new ClipboardMonitor(_clipboardWindow.Handle, _tempDir);
            _clipboard.ImageArrived += OnClipboardImage;
            _clipboard.TextArrived += OnClipboardText;
            _clipboard.Failed += OnHelperError;

            _tray = new TrayIcon();
            _tray.Clicked += OnTrayClick;
            _tray.QuitRequested += delegate { RequestQuit(true); };
            _tray.Failed += OnHelperError;

            _folderWatcher = new FolderWatcher(_screenshotDir);
            // Clipboard spills are our own output; never report them back as PC Captures.
            _folderWatcher.ExcludedRoot = _tempDir;
            _folderWatcher.Captured += OnFileCaptured;
            _folderWatcher.Failed += OnHelperError;

            Log.Info("runtime constructed; temp=" + _tempDir + " screenshots=" + _screenshotDir);
        }

        public string ScreenshotDir
        {
            get { return _screenshotDir; }
        }

        /// <summary>Idempotent: a repeated {"cmd":"start"} is a no-op.</summary>
        public void StartMonitors()
        {
            if (_startedMonitors)
            {
                Log.Info("start received again; already running");
                return;
            }
            _startedMonitors = true;

            if (!_clipboardWindow.StartListening())
            {
                ReportError("clipboard-unavailable",
                    "无法注册剪贴板监听（win32 错误），剪贴板同步不可用");
            }
            _clipboard.Start();

            // A file saved while the helper was down would otherwise never be delivered.
            if (!_folderWatcher.Start(true))
            {
                // Start() already reported the reason.
            }

            Program.EmitReadyOnce();
        }

        public void SetPaused(bool paused)
        {
            _paused = paused;
            if (_clipboard != null) _clipboard.Paused = paused;
            RunOnUi(delegate { _tray.SetPaused(paused); });
            Log.Info("paused=" + paused);
        }

        public void SetTrayState(string state, string device)
        {
            TrayState parsed = TrayState.Disconnected;
            if (string.Equals(state, "connected", StringComparison.OrdinalIgnoreCase)) parsed = TrayState.Connected;
            else if (string.Equals(state, "paused", StringComparison.OrdinalIgnoreCase)) parsed = TrayState.Paused;
            else if (!string.Equals(state, "disconnected", StringComparison.OrdinalIgnoreCase)
                     && !string.IsNullOrEmpty(state))
            {
                ReportError("bad-command", "未知的托盘状态：" + state);
                return;
            }

            RunOnUi(delegate { _tray.SetState(parsed, device); });
        }

        public void ShowQr(string payload)
        {
            if (string.IsNullOrEmpty(payload))
            {
                ReportError("bad-command", "show-qr 缺少 payload");
                return;
            }
            RunOnUi(delegate
            {
                if (_qrForm != null ? (_qrForm.IsDisposed || !_qrForm.Encoded) : true)
                {
                    if (_qrForm != null && !_qrForm.IsDisposed && !_qrForm.Encoded)
                    {
                        // A previous over-long payload: force a fresh form for the new one.
                        _qrForm.Close();
                        _qrForm.Dispose();
                    }
                    _qrForm = new QrForm(payload);
                }
                _qrForm.ShowCentered();
                if (!_qrForm.Encoded)
                {
                    ReportError("qr-too-long",
                        string.Format("二维码载荷 {0} 字节，超出内置编码器上限 {1} 字节；已改为显示文本。",
                            System.Text.Encoding.UTF8.GetByteCount(payload), QrCode.MaxPayloadBytes));
                }
                Log.Info("show-qr: " + payload);
            });
        }

        public void HideQr()
        {
            RunOnUi(delegate
            {
                if (_qrForm != null && !_qrForm.IsDisposed) _qrForm.Hide();
            });
        }

        public void Notify(string title, string body, string thumbFile)
        {
            RunOnUi(delegate { _tray.ShowBalloon(title, body, thumbFile); });
        }

        /// <summary>
        /// Hub → Windows clipboard, image. The write is an Echo (CONTEXT.md) and is
        /// suppressed: no clipboard-image event is emitted for it.
        /// </summary>
        public void SetClipboardImage(string file)
        {
            if (string.IsNullOrEmpty(file))
            {
                ReportError("bad-command", "set-clipboard-image 缺少 file");
                return;
            }
            if (!File.Exists(file))
            {
                ReportError("file-missing", "图片不存在：" + file);
                return;
            }

            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(file);
            }
            catch (Exception ex)
            {
                ReportError("file-missing", "无法读取图片：" + Paths.Describe(ex));
                return;
            }

            // Arm the echo guards BEFORE the write: WM_CLIPBOARDUPDATE is delivered to the very
            // next pump iteration, and the reader thread can win the race against code that
            // runs after SetClipboardData. Recording afterwards would let our own write escape
            // as a clipboard-image event and loop back to the phone (SPEC §4 invariant 1).
            _clipboard.RecordEchoImage(bytes);
            _clipboard.ArmSelfWriteImage();

            string error;
            if (!Clipboard.WriteImage(_clipboardWindow.Handle, bytes, out error))
            {
                _clipboard.CancelSelfWrite();
                ReportError("clipboard-write-failed", "写入剪贴板失败：" + error);
                return;
            }
            Log.Info("clipboard image written from " + file);
        }

        public void SetClipboardText(string text)
        {
            if (text == null)
            {
                ReportError("bad-command", "set-clipboard-text 缺少 text");
                return;
            }

            // See SetClipboardImage: guard first, write second.
            _clipboard.RecordEchoText(text);
            _clipboard.ArmSelfWriteText();

            string error;
            if (!Clipboard.WriteText(_clipboardWindow.Handle, text, out error))
            {
                _clipboard.CancelSelfWrite();
                ReportError("clipboard-write-failed", "写入剪贴板失败：" + error);
                return;
            }
            Log.Info("clipboard text written, " + text.Length + " chars");
        }

        public void RequestQuit(bool emitEvent)
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
            Log.Info("quit requested");

            if (emitEvent) Program.EmitTrayClick("quit", null);

            RunOnUi(delegate
            {
                if (_qrForm != null && !_qrForm.IsDisposed)
                {
                    try
                    {
                        _qrForm.Close();
                    }
                    catch (Exception ex)
                    {
                        Log.Warn("qr close: " + Paths.Describe(ex));
                    }
                }
            });

            // Application.Exit ends the message loop regardless of which thread asks. ExitThread
            // would only end the *caller's* loop, which is why the stdin reader must not call it.
            RunOnUi(delegate
            {
                try
                {
                    Application.Exit();
                }
                catch (Exception ex)
                {
                    Log.Error("Application.Exit failed: " + Paths.Describe(ex));
                }
            });

            // Backstop: if a modal popup or a stuck pump refuses to unwind, do not leave an
            // orphan process behind — the Hub's supervisor would see a live but mute child.
            Thread watchdog = new Thread(delegate()
            {
                Thread.Sleep(3000);
                Log.Error("graceful shutdown timed out; forcing exit");
                Environment.Exit(0);
            });
            watchdog.IsBackground = true;
            watchdog.Name = "LinkOK.QuitWatchdog";
            watchdog.Start();
        }

        public void ReportError(string code, string message)
        {
            Program.EmitError(code, message);
        }

        public void Shutdown()
        {
            _shuttingDown = true;
            if (_clipboard != null) _clipboard.Dispose();
            if (_folderWatcher != null) _folderWatcher.Dispose();
            RunOnUi(delegate
            {
                if (_tray != null) _tray.Dispose();
            });
            if (_clipboardWindow != null) _clipboardWindow.Dispose();
        }

        // ── Event plumbing: workers → UI thread → stdout ──────────────────────

        private void OnClipboardUpdate(object sender, EventArgs e)
        {
            if (_clipboard != null) _clipboard.NotifyUpdate();
        }

        private void OnClipboardImage(object sender, ClipboardImageEvent e)
        {
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "clipboard-image");
            writer.Prop("file", e.File);
            writer.Prop("sha256", e.Sha256);
            writer.Prop("width", e.Width);
            writer.Prop("height", e.Height);
            writer.Prop("bytes", e.Bytes);
            Program.Emit(writer.Close());
            Log.Info(string.Format("clipboard-image {0} {1}x{2} from {3}",
                e.Sha256.Substring(0, 12), e.Width, e.Height, e.Source));
        }

        private void OnClipboardText(object sender, ClipboardTextEvent e)
        {
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "clipboard-text");
            writer.Prop("text", e.Text);
            writer.Prop("sha256", e.Sha256);
            writer.Prop("chars", e.Chars);
            writer.Prop("truncated", e.Truncated);
            Program.Emit(writer.Close());
            Log.Info("clipboard-text " + e.Sha256.Substring(0, 12) + " (" + e.Chars + " chars"
                     + (e.Truncated ? ", truncated" : "") + ")");
        }

        private void OnFileCaptured(object sender, FileCapturedEvent e)
        {
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "file-captured");
            writer.Prop("file", e.File);
            writer.Prop("sha256", e.Sha256);
            writer.Prop("width", e.Width);
            writer.Prop("height", e.Height);
            writer.Prop("bytes", e.Bytes);
            writer.Prop("name", e.Name);
            Program.Emit(writer.Close());
            Log.Info("file-captured " + e.Name + " " + e.Sha256.Substring(0, 12));
        }

        private void OnTrayClick(object sender, TrayClickEvent e)
        {
            Program.EmitTrayClick(e.Item, e.Enabled);
        }

        private void OnHelperError(object sender, HelperError e)
        {
            Program.EmitError(e.Code, e.Message);
        }

        /// <summary>
        /// Run on the UI thread. The runtime object and every window it owns are created on
        /// the thread that calls <see cref="Start"/>, which is the thread running the message
        /// loop; commands arrive from the stdin thread and must be marshalled.
        /// </summary>
        private static void RunOnUi(MethodInvoker action)
        {
            if (action == null) return;
            try
            {
                // Marshalling must be decided by thread identity, not by Application.MessageLoop:
                // during startup there is no loop yet but we *are* the UI thread.
                if (_uiThreadId == 0 || Thread.CurrentThread.ManagedThreadId == _uiThreadId)
                {
                    action();
                    return;
                }
                HiddenInvoker.Invoke(action);
            }
            catch (Exception ex)
            {
                Log.Error("UI marshalling failed: " + Paths.Describe(ex));
            }
        }
    }

    /// <summary>
    /// A never-shown form whose handle is used only to marshal onto the UI thread.
    ///
    /// The anchor must be created ON the UI thread. Creating it lazily from whichever thread
    /// called first made InvokeRequired answer false (the handle then belonged to the calling
    /// thread), so commands ran inline on the stdin thread — which has no message pump. A
    /// window created there is shown but never paints (this is what made the QR window blank).
    /// </summary>
    internal static class HiddenInvoker
    {
        private static Form _anchor;
        private static readonly object Gate = new object();

        /// <summary>Must be called from the UI thread before any command is dispatched.</summary>
        public static void Initialize()
        {
            lock (Gate)
            {
                if (_anchor != null && !_anchor.IsDisposed) return;
                Form anchor = new Form();
                anchor.ShowInTaskbar = false;
                anchor.FormBorderStyle = FormBorderStyle.None;
                anchor.StartPosition = FormStartPosition.Manual;
                anchor.Location = new System.Drawing.Point(-32000, -32000);
                anchor.Size = new System.Drawing.Size(1, 1);
                anchor.Show(); // materialises the handle on this thread
                anchor.Hide();
                _anchor = anchor;
            }
        }

        public static void Invoke(MethodInvoker action)
        {
            if (action == null) return;
            Form anchor;
            lock (Gate)
            {
                anchor = _anchor;
            }
            if (anchor == null || anchor.IsDisposed)
            {
                Log.Error("HiddenInvoker used before Initialize(); running inline");
                action();
                return;
            }
            if (anchor.InvokeRequired) anchor.Invoke(action);
            else action();
        }
    }
}
