// LinkOK helper — the Tray (SPEC §5.8, SPEC §3.1 "原生 Win32 Shell_NotifyIcon").
//
// Menu items per SPEC:
//   状态区（不可点） | 打开设置 | 配对新设备 | 暂停同步 | 开机自启（勾选） | 退出
//
// The helper does not own the Hub, so 打开设置 / 配对新设备 / 暂停同步 are reported as
// {"evt":"tray-click","item":"…"} for the Hub to act on (PROTOCOL §11). 退出 quits at once
// and 开机自启 is written to HKCU\…\Run — the two documented exceptions.
//
// Why Shell_NotifyIcon rather than System.Windows.Forms.NotifyIcon: a toast with a thumbnail
// needs NIF_INFO + NIIF_USER + hBalloonIcon, and NotifyIcon does not expose hBalloonIcon.
// The menu itself is still a ContextMenuStrip popup, which does not depend on NotifyIcon.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LinkOK.Helper
{
    internal sealed class TrayIcon : IDisposable, IMessageFilter
    {
        public const string RunValueName = "LinkOK";

        // Shell_NotifyIcon
        private const int NIM_ADD = 0x00;
        private const int NIM_MODIFY = 0x01;
        private const int NIM_DELETE = 0x02;
        private const int NIM_SETVERSION = 0x04;

        private const int NIF_MESSAGE = 0x01;
        private const int NIF_ICON = 0x02;
        private const int NIF_TIP = 0x04;
        private const int NIF_INFO = 0x10;
        private const int NIF_SHOWTIP = 0x80;

        private const int NIIF_USER = 0x04;
        private const int NIIF_NOSOUND = 0x10;

        private const int NOTIFYICON_VERSION_4 = 4;

        private const int WM_APP = 0x8000;
        private const int WM_TRAY = WM_APP + 1;
        private const int WM_CONTEXTMENU = 0x007B;
        private const int WM_RBUTTONUP = 0x0205;
        private const int WM_LBUTTONDBLCLK = 0x0203;
        private const int NIN_SELECT = 0x0400;
        private const int NIN_KEYSELECT = 0x0401;
        private const int NIN_BALLOONUSERCLICK = 0x0405;

        private const int TrayIconId = 1;

        private readonly TrayWindow _window;
        private readonly ContextMenuStrip _menu;
        private readonly ToolStripMenuItem _statusItem;
        private readonly ToolStripMenuItem _pauseItem;
        private readonly ToolStripMenuItem _autostartItem;

        private Icon _icon;
        private IntPtr _balloonIcon = IntPtr.Zero;
        private Timer _balloonIconTimer;
        private TrayState _state = TrayState.Disconnected;
        private bool _paused;
        private string _device = string.Empty;
        private bool _updatingAutostart;
        private bool _added;
        private bool _disposed;

        public TrayIcon()
        {
            _window = new TrayWindow();
            _window.Callback = OnTrayMessage;

            _menu = new ContextMenuStrip();
            _menu.ShowImageMargin = false;
            _menu.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);

            ToolStripLabel brand = new ToolStripLabel("LinkOK");
            brand.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold, GraphicsUnit.Point);
            brand.ForeColor = Color.FromArgb(0x33, 0x33, 0x33);
            _menu.Items.Add(brand);
            _menu.Items.Add(new ToolStripSeparator());

            // Status line: disabled so it reads as a label, not as an action.
            _statusItem = new ToolStripMenuItem("手机未连接");
            _statusItem.Enabled = false;
            _menu.Items.Add(_statusItem);
            _menu.Items.Add(new ToolStripSeparator());

            _menu.Items.Add(CreateItem("打开设置", delegate { Raise("settings", null); }));
            _menu.Items.Add(CreateItem("配对新设备", delegate { Raise("pair", null); }));

            _pauseItem = new ToolStripMenuItem("暂停同步");
            _pauseItem.Click += delegate { Raise("pause", !_paused); };
            _menu.Items.Add(_pauseItem);

            _autostartItem = new ToolStripMenuItem("开机自启");
            _autostartItem.CheckOnClick = false;
            _autostartItem.Click += delegate { OnAutostartClick(); };
            _menu.Items.Add(_autostartItem);

            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add(CreateItem("退出", delegate { RaiseQuit(); }));

            _updatingAutostart = true;
            try
            {
                _autostartItem.Checked = IsAutostartEnabled();
            }
            finally
            {
                _updatingAutostart = false;
            }

            ApplyIcon();
            ApplyTexts();
            AddToShell();
        }

        public event EventHandler<TrayClickEvent> Clicked;
        public event EventHandler QuitRequested;
        public event EventHandler<HelperError> Failed;

        public TrayState State
        {
            get { return _state; }
        }

        public bool Paused
        {
            get { return _paused; }
        }

        public bool AutostartEnabled
        {
            get { return _autostartItem.Checked; }
        }

        /// <summary>True once the shell accepted the icon; false means no interactive session.</summary>
        public bool Visible
        {
            get { return _added; }
        }

        private static ToolStripMenuItem CreateItem(string text, EventHandler onClick)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.Click += onClick;
            return item;
        }

        // ── Shell_NotifyIcon plumbing ─────────────────────────────────────────

        private void AddToShell()
        {
            NOTIFYICONDATA data = BuildData(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
            data.uCallbackMessage = WM_TRAY;
            data.szTip = CurrentTip();
            data.hIcon = _icon == null ? IntPtr.Zero : _icon.Handle;

            if (NativeMethods.Shell_NotifyIcon(NIM_ADD, ref data) == 0)
            {
                int err = Marshal.GetLastWin32Error();
                Log.Error("Shell_NotifyIcon(NIM_ADD) failed, win32=" + err
                          + " — no interactive desktop or shell?");
                RaiseError("tray-unavailable",
                    "无法创建托盘图标（win32=" + err + "），helper 可能运行在非交互会话中");
                return;
            }

            NOTIFYICONDATA version = BuildData(0);
            version.uTimeoutOrVersion = NOTIFYICON_VERSION_4;
            if (NativeMethods.Shell_NotifyIcon(NIM_SETVERSION, ref version) == 0)
            {
                Log.Warn("NIM_SETVERSION failed, win32=" + Marshal.GetLastWin32Error());
            }

            _added = true;
            Application.AddMessageFilter(this);
        }

        private NOTIFYICONDATA BuildData(int flags)
        {
            NOTIFYICONDATA data = new NOTIFYICONDATA();
            data.cbSize = Marshal.SizeOf(typeof(NOTIFYICONDATA));
            data.hWnd = _window.Handle;
            data.uID = TrayIconId;
            data.uFlags = flags;
            data.szTip = string.Empty;
            data.szInfo = string.Empty;
            data.szInfoTitle = string.Empty;
            return data;
        }

        private void Modify(int flags)
        {
            if (!_added) return;
            NOTIFYICONDATA data = BuildData(flags);
            if (_icon != null) data.hIcon = _icon.Handle;
            data.szTip = CurrentTip();
            if (NativeMethods.Shell_NotifyIcon(NIM_MODIFY, ref data) == 0)
            {
                Log.Warn("Shell_NotifyIcon(NIM_MODIFY) failed, win32=" + Marshal.GetLastWin32Error());
            }
        }

        private string CurrentTip()
        {
            string status;
            if (_paused) status = "已暂停同步";
            else if (_state == TrayState.Connected)
            {
                status = "已连接" + (string.IsNullOrEmpty(_device) ? string.Empty : "：" + _device);
            }
            else status = "手机未连接";

            string tip = "LinkOK — " + status;
            if (tip.Length > 120) tip = tip.Substring(0, 120);
            return tip;
        }

        /// <summary>Message filter so the tray window sees the callback even when a form has focus.</summary>
        public bool PreFilterMessage(ref Message m)
        {
            return false; // the tray window is a real HWND; the pump routes WM_TRAY to it
        }

        private void OnTrayMessage(int message, int lowWord)
        {
            switch (lowWord)
            {
                case WM_CONTEXTMENU:
                case WM_RBUTTONUP:
                    ShowMenu();
                    break;
                case WM_LBUTTONDBLCLK:
                case NIN_SELECT:
                case NIN_KEYSELECT:
                    Raise("settings", null);
                    break;
                case NIN_BALLOONUSERCLICK:
                    Raise("settings", null);
                    break;
            }
            if (message != 0 && lowWord == 0) Log.Warn("unhandled tray message " + message);
        }

        private void ShowMenu()
        {
            try
            {
                // Required so the popup closes when the user clicks elsewhere.
                NativeMethods.SetForegroundWindow(_window.Handle);
                _menu.Show(Cursor.Position);
            }
            catch (Exception ex)
            {
                RaiseError("tray-menu", "显示托盘菜单失败：" + Paths.Describe(ex));
            }
        }

        // ── Public state ──────────────────────────────────────────────────────

        public void SetState(TrayState state, string device)
        {
            _state = state;
            _paused = state == TrayState.Paused;
            _device = device == null ? string.Empty : device.Trim();
            ApplyIcon();
            ApplyTexts();
        }

        public void SetPaused(bool paused)
        {
            _paused = paused;
            if (paused) _state = TrayState.Paused;
            else if (_state == TrayState.Paused) _state = TrayState.Disconnected;
            ApplyIcon();
            ApplyTexts();
        }

        private void ApplyTexts()
        {
            if (_paused) _statusItem.Text = "已暂停同步";
            else if (_state == TrayState.Connected)
            {
                _statusItem.Text = string.IsNullOrEmpty(_device)
                    ? "已连接"
                    : "已连接：" + _device;
            }
            else _statusItem.Text = "手机未连接";

            _pauseItem.Text = _paused ? "恢复同步" : "暂停同步";
            _pauseItem.Checked = _paused;
            Modify(NIF_TIP | NIF_SHOWTIP);
        }

        private void ApplyIcon()
        {
            Icon next = TrayArt.Create(_state);
            Icon previous = _icon;
            _icon = next;
            Modify(NIF_ICON | NIF_TIP);
            if (previous != null) previous.Dispose();
        }

        // ── Notifications ─────────────────────────────────────────────────────

        /// <summary>
        /// SPEC §5.7: a Windows notification, with the capture thumbnail when one is given.
        /// The thumbnail becomes the toast's icon (NIIF_USER + hBalloonIcon), which is the only
        /// image a shell notification can carry.
        /// </summary>
        public void ShowBalloon(string title, string body, string thumbFile)
        {
            // Validate the thumbnail before the tray check so a bad path is reported as such
            // even when the tray itself is unavailable — the Hub can then fix the path.
            if (!string.IsNullOrEmpty(thumbFile) && !File.Exists(thumbFile))
            {
                RaiseError("thumb-missing", "通知缩略图不存在：" + thumbFile);
                thumbFile = null;
            }

            if (!_added)
            {
                RaiseError("notify-unavailable", "托盘图标不可用，无法显示通知");
                return;
            }
            try
            {
                IntPtr balloonIcon = IntPtr.Zero;
                bool custom = false;
                if (!string.IsNullOrEmpty(thumbFile))
                {
                    balloonIcon = CreateBalloonIcon(thumbFile);
                    custom = balloonIcon != IntPtr.Zero;
                }

                NOTIFYICONDATA data = BuildData(NIF_INFO | NIF_ICON | NIF_TIP);
                if (_icon != null) data.hIcon = _icon.Handle;
                data.szTip = CurrentTip();
                data.szInfoTitle = Clip(title ?? "LinkOK", 63);
                data.szInfo = Clip(body ?? string.Empty, 255);
                data.dwInfoFlags = custom ? (NIIF_USER | NIIF_NOSOUND) : NIIF_NOSOUND;
                data.hBalloonIcon = balloonIcon;

                if (NativeMethods.Shell_NotifyIcon(NIM_MODIFY, ref data) == 0)
                {
                    int err = Marshal.GetLastWin32Error();
                    RaiseError("notify-failed", "显示通知失败，win32=" + err);
                    if (balloonIcon != IntPtr.Zero) NativeMethods.DestroyIcon(balloonIcon);
                    return;
                }

                if (balloonIcon != IntPtr.Zero) ScheduleIconCleanup(balloonIcon);
            }
            catch (Exception ex)
            {
                RaiseError("notify-failed", "显示通知失败：" + Paths.Describe(ex));
            }
        }

        private static string Clip(string text, int max)
        {
            if (text == null) return string.Empty;
            return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
        }

        /// <summary>Rasterise the thumbnail down to a 48px square HICON for the toast.</summary>
        private static IntPtr CreateBalloonIcon(string file)
        {
            try
            {
                using (Bitmap source = ImageFile.DecodeFile(file))
                using (Bitmap square = new Bitmap(48, 48, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(square))
                    {
                        g.Clear(Color.Transparent);
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        float scale = Math.Min(48f / source.Width, 48f / source.Height);
                        int w = Math.Max(1, (int)Math.Round(source.Width * scale));
                        int h = Math.Max(1, (int)Math.Round(source.Height * scale));
                        g.DrawImage(source, (48 - w) / 2, (48 - h) / 2, w, h);
                    }
                    return square.GetHicon();
                }
            }
            catch (Exception ex)
            {
                Log.Warn("thumbnail icon failed for " + file + ": " + Paths.Describe(ex));
                return IntPtr.Zero;
            }
        }

        private void ScheduleIconCleanup(IntPtr handle)
        {
            // The shell copies the icon, but keeping it alive briefly is cheap insurance.
            if (_balloonIconTimer != null)
            {
                _balloonIconTimer.Stop();
                _balloonIconTimer.Dispose();
            }
            if (_balloonIcon != IntPtr.Zero) NativeMethods.DestroyIcon(_balloonIcon);
            _balloonIcon = handle;
            Timer timer = new Timer();
            timer.Interval = 15000;
            timer.Tick += delegate
            {
                timer.Stop();
                timer.Dispose();
                if (_balloonIcon != IntPtr.Zero)
                {
                    NativeMethods.DestroyIcon(_balloonIcon);
                    _balloonIcon = IntPtr.Zero;
                }
                if (ReferenceEquals(_balloonIconTimer, timer)) _balloonIconTimer = null;
            };
            _balloonIconTimer = timer;
            timer.Start();
        }

        // ── Autostart (SPEC §5.8, the documented exception) ──────────────────

        public bool SetAutostart(bool enabled, out string error)
        {
            error = null;
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key == null)
                    {
                        error = "无法打开 HKCU\\…\\Run 注册表项";
                        return false;
                    }
                    if (enabled)
                    {
                        key.SetValue(RunValueName, "\"" + Application.ExecutablePath + "\"",
                            RegistryValueKind.String);
                    }
                    else
                    {
                        if (key.GetValue(RunValueName) != null) key.DeleteValue(RunValueName, false);
                    }
                }
            }
            catch (Exception ex)
            {
                error = Paths.Describe(ex);
                return false;
            }

            _updatingAutostart = true;
            try
            {
                _autostartItem.Checked = enabled;
            }
            finally
            {
                _updatingAutostart = false;
            }
            return true;
        }

        public static bool IsAutostartEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run", false))
                {
                    return key != null && key.GetValue(RunValueName) != null;
                }
            }
            catch (Exception ex)
            {
                Log.Warn("autostart probe failed: " + Paths.Describe(ex));
                return false;
            }
        }

        // ── Events ────────────────────────────────────────────────────────────

        private void Raise(string item, bool? enabled)
        {
            EventHandler<TrayClickEvent> handler = Clicked;
            if (handler != null) handler(this, new TrayClickEvent(item, enabled));
        }

        private void RaiseQuit()
        {
            EventHandler handler = QuitRequested;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private void OnAutostartClick()
        {
            if (_updatingAutostart) return;
            bool wanted = !_autostartItem.Checked;
            string error;
            if (!SetAutostart(wanted, out error))
            {
                RaiseError("autostart-failed", "设置开机自启失败：" + error);
                return;
            }
            Log.Info("autostart " + (wanted ? "enabled" : "disabled"));
            Raise("autostart", wanted);
        }

        private void RaiseError(string code, string message)
        {
            Log.Error(code + ": " + message);
            EventHandler<HelperError> handler = Failed;
            if (handler != null) handler(this, new HelperError(code, message));
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                Application.RemoveMessageFilter(this);
            }
            catch (Exception ex)
            {
                Log.Warn("message filter removal: " + Paths.Describe(ex));
            }
            if (_added)
            {
                NOTIFYICONDATA data = BuildData(0);
                if (NativeMethods.Shell_NotifyIcon(NIM_DELETE, ref data) == 0)
                {
                    Log.Warn("Shell_NotifyIcon(NIM_DELETE) failed, win32=" + Marshal.GetLastWin32Error());
                }
                _added = false;
            }
            if (_balloonIconTimer != null)
            {
                _balloonIconTimer.Stop();
                _balloonIconTimer.Dispose();
                _balloonIconTimer = null;
            }
            if (_balloonIcon != IntPtr.Zero)
            {
                NativeMethods.DestroyIcon(_balloonIcon);
                _balloonIcon = IntPtr.Zero;
            }
            _menu.Dispose();
            if (_icon != null)
            {
                _icon.Dispose();
                _icon = null;
            }
            _window.DestroyHandle();
        }

        /// <summary>Hidden window that receives the Shell_NotifyIcon callback.</summary>
        private sealed class TrayWindow : NativeWindow
        {
            public Action<int, int> Callback;

            public TrayWindow()
            {
                CreateParams cp = new CreateParams();
                cp.Caption = "LinkOK.Helper.Tray";
                // No WS_VISIBLE: a plain top-level window, never shown.
                cp.Style = 0;
                cp.ExStyle = 0;
                CreateHandle(cp);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_TRAY)
                {
                    int low = (int)(m.LParam.ToInt64() & 0xFFFF);
                    Action<int, int> callback = Callback;
                    if (callback != null)
                    {
                        try
                        {
                            callback(m.Msg, low);
                        }
                        catch (Exception ex)
                        {
                            Log.Error("tray callback threw: " + Paths.Describe(ex));
                        }
                    }
                    return;
                }
                base.WndProc(ref m);
            }
        }
    }

    internal sealed class TrayClickEvent : EventArgs
    {
        public TrayClickEvent(string item) : this(item, null) { }

        public TrayClickEvent(string item, bool? enabled)
        {
            Item = item;
            Enabled = enabled;
        }

        public string Item { get; private set; }

        /// <summary>Only meaningful for "autostart" (its new value) and "pause" (requested state).</summary>
        public bool? Enabled { get; private set; }
    }
}
