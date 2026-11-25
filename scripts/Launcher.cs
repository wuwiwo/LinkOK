// LinkOK 图形启动器（C# / .NET Framework 4.8，系统自带 csc 编译）
//
// 为什么不是控制台程序：用户要的是"双击就有界面"。控制台窗口既挡视线、
// 又容易被误关，而且配对码藏在一堆日志里很难找。
//
// 这个程序做四件事：
//   1. 找到 Node（PATH → 工程内 node.exe → 常见安装路径 → LINKOK_NODE）
//   2. 把 Hub 作为子进程拉起，转发它的 stdout/stderr 到日志与状态栏
//   3. 显示二维码窗口，让手机直接扫
//   4. 托盘图标 + 右键菜单（打开设置页 / 复制配对链接 / 退出）
//
// QR 编码复用 pc/helper/QrCode.cs（同一份源码，不重复实现）。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class AppInfo
{
    public const string Title = "LinkOK";
}

internal static class Launcher
{
    /// <summary>
    /// 单实例互斥体。
    ///
    /// 为什么必须有：两个 LinkOK.exe 会各自拉起一个 Hub，后启动的那个绑不上 8787，
    /// 界面上就出现「LinkOK 已停止（代码 2）」—— 用户看到的是"启动失败"，
    /// 真实原因却是"已经有一个在跑了"。没有这个保护，用户只会不断重试。
    /// </summary>
    private static Mutex _instanceMutex;

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool createdNew;
        _instanceMutex = new Mutex(true, @"Local\LinkOK.SingleInstance", out createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                "LinkOK 已经在运行了。\n\n" +
                "看任务栏右下角的托盘图标，双击它可以重新打开窗口。\n" +
                "如果看不到图标，请在任务管理器里结束 LinkOK.exe 后重试。",
                AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        string root = FindRoot();
        if (root == null)
        {
            MessageBox.Show(
                "找不到 LinkOK 目录。\n\n请把 LinkOK.exe 放在 LinkOK 根目录下（与 pc\\ 文件夹同级）。",
                AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string node = FindNode(root);
        if (node == null)
        {
            MessageBox.Show(
                "没有找到 Node.js。\n\n" +
                "LinkOK 的电脑端需要 Node.js 20 以上。\n\n" +
                "任选一种解决：\n" +
                "  · 到 https://nodejs.org 下载安装\n" +
                "  · 把 node.exe 复制到 LinkOK 文件夹里\n" +
                "  · 设置环境变量 LINKOK_NODE 指向 node.exe",
                AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LINKOK_DATA_DIR")))
        {
            Environment.SetEnvironmentVariable("LINKOK_DATA_DIR", Path.Combine(root, ".pc-data"));
        }

        using (var ui = new MainWindow(root, node))
        {
            Application.Run(ui);
            return ui.ExitCode;
        }
    }

    private static string FindRoot()
    {
        string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        for (int i = 0; i < 4 && !string.IsNullOrEmpty(dir); i++)
        {
            if (File.Exists(Path.Combine(dir, "pc", "src", "main.js"))) return dir;
            dir = Path.GetDirectoryName(dir);
        }
        string cwd = Directory.GetCurrentDirectory();
        if (File.Exists(Path.Combine(cwd, "pc", "src", "main.js"))) return cwd;
        return null;
    }

    private static string FindNode(string root)
    {
        string explicitPath = Environment.GetEnvironmentVariable("LINKOK_NODE");
        if (!string.IsNullOrEmpty(explicitPath) && File.Exists(explicitPath)) return explicitPath;

        string bundled = Path.Combine(root, "node.exe");
        if (File.Exists(bundled)) return bundled;

        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in pathVar.Split(';'))
        {
            if (string.IsNullOrWhiteSpace(part)) continue;
            try
            {
                string candidate = Path.Combine(part.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }

        string[] guesses =
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                         "Programs", "nodejs", "node.exe"),
        };
        foreach (string guess in guesses)
        {
            if (File.Exists(guess)) return guess;
        }
        return null;
    }
}

/// <summary>主窗口：状态 + 二维码 + 配对码 + 三个按钮。</summary>
internal sealed class MainWindow : Form
{
    private readonly string _root;
    private readonly string _node;
    private Process _hub;

    private readonly Label _statusLabel;
    private readonly Label _codeLabel;
    private readonly TextBox _payloadBox;
    private readonly PictureBox _qrBox;
    private readonly Label _qrHint;
    private readonly TextBox _logBox;
    private readonly Button _copyButton;
    private Button _settingsButton;

    private string _currentPayload;
    private Bitmap _qrBitmap;
    private NotifyIcon _tray;
    private bool _closingForReal;

    public int ExitCode { get; private set; }

    public MainWindow(string root, string node)
    {
        _root = root;
        _node = node;

        Text = "LinkOK";
        ClientSize = new Size(520, 640);
        MinimumSize = new Size(460, 560);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(0xFB, 0xFD, 0xF8);
        Font = new Font("Microsoft YaHei UI", 9f);
        Icon = SystemIcons.Application;

        // ── 顶部状态 ──
        _statusLabel = new Label
        {
            Text = "正在启动…",
            AutoSize = false,
            Height = 26,
            Left = 20,
            Top = 16,
            Width = ClientSize.Width - 40,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold),
            ForeColor = Color.FromArgb(0x19, 0x1C, 0x1A),
        };
        Controls.Add(_statusLabel);

        // ── 二维码 ──
        _qrBox = new PictureBox
        {
            Left = (ClientSize.Width - 240) / 2,
            Top = 52,
            Width = 240,
            Height = 240,
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            Anchor = AnchorStyles.Top,
        };
        Controls.Add(_qrBox);

        _qrHint = new Label
        {
            Text = "用手机 LinkOK 扫码配对",
            TextAlign = ContentAlignment.MiddleCenter,
            Left = 20,
            Top = 298,
            Width = ClientSize.Width - 40,
            Height = 20,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            ForeColor = Color.FromArgb(0x40, 0x49, 0x43),
        };
        Controls.Add(_qrHint);

        // ── 配对码 ──
        _codeLabel = new Label
        {
            Text = "",
            TextAlign = ContentAlignment.MiddleCenter,
            Left = 20,
            Top = 320,
            Width = ClientSize.Width - 40,
            Height = 30,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Font = new Font("Consolas", 17f, FontStyle.Bold),
            ForeColor = Color.FromArgb(0x1B, 0x6C, 0x4B),
        };
        Controls.Add(_codeLabel);

        // ── 链接（可复制）──
        _payloadBox = new TextBox
        {
            Left = 20,
            Top = 354,
            Width = ClientSize.Width - 40,
            Height = 22,
            ReadOnly = true,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            BackColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
        };
        Controls.Add(_payloadBox);

        // ── 按钮 ──
        _copyButton = MakeButton("复制配对链接", 20, 384, 150);
        _copyButton.Click += (s, e) => CopyPayload();
        Controls.Add(_copyButton);

        Button settingsBtn = MakeButton("打开设置页", 180, 384, 130);
        _settingsButton = settingsBtn;
        settingsBtn.Click += (s, e) => OpenSettings();
        Controls.Add(settingsBtn);

        Button newCodeBtn = MakeButton("换个配对码", 320, 384, 120);
        newCodeBtn.Click += (s, e) => RequestNewCode();
        Controls.Add(newCodeBtn);

        // ── 日志 ──
        _logBox = new TextBox
        {
            Left = 20,
            Top = 424,
            Width = ClientSize.Width - 40,
            Height = ClientSize.Height - 444,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = true,
            BackColor = Color.FromArgb(0xF2, 0xF5, 0xF1),
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Consolas", 8.5f),
            Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
        };
        Controls.Add(_logBox);

        BuildTray();
    }

    private Button MakeButton(string text, int left, int top, int width)
    {
        return new Button
        {
            Text = text,
            Left = left,
            Top = top,
            Width = width,
            Height = 30,
            FlatStyle = FlatStyle.System,
        };
    }

    private void BuildTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开设置页", null, (s, e) => OpenSettings());
        menu.Items.Add("复制配对链接", null, (s, e) => CopyPayload());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (s, e) => { _closingForReal = true; Close(); });

        _tray = new NotifyIcon
        {
            Text = AppInfo.Title,
            Visible = true,
            ContextMenuStrip = menu,
            Icon = SystemIcons.Application,
        };
        _tray.DoubleClick += (s, e) => { Show(); Activate(); };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        StartHub();
    }

    private void StartHub()
    {
        var psi = new ProcessStartInfo
        {
            FileName = _node,
            Arguments = "\"" + Path.Combine(_root, "pc", "src", "main.js") + "\"",
            WorkingDirectory = _root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        try
        {
            _hub = Process.Start(psi);
        }
        catch (Exception ex)
        {
            SetStatus("启动失败：" + ex.Message, Color.Firebrick);
            AppendLog("[错误] 无法启动 Node：" + ex.Message);
            return;
        }

        if (_hub == null)
        {
            SetStatus("启动失败", Color.Firebrick);
            return;
        }

        _hub.OutputDataReceived += (s, e) => OnHubLine(e.Data);
        _hub.ErrorDataReceived += (s, e) => OnHubLine(e.Data);
        _hub.BeginOutputReadLine();
        _hub.BeginErrorReadLine();

        _hub.EnableRaisingEvents = true;
        _hub.Exited += (s, e) =>
        {
            int code;
            try { code = _hub.ExitCode; } catch { code = -1; }
            ExitCode = code;
            if (!_closingForReal)
            {
                SafeInvoke(() =>
                {
                    SetStatus("LinkOK 已停止（代码 " + code + "）", Color.Firebrick);
                    AppendLog("[退出] Hub 进程结束，代码 " + code);
                    // Hub 没了，设置页必然打不开。禁用按钮，而不是让用户点了没反应。
                    if (_settingsButton != null) _settingsButton.Enabled = false;
                });
            }
        };
    }

    private void OnHubLine(string line)
    {
        if (line == null) return;
        SafeInvoke(() => ApplyHubLine(line));
    }

    private static readonly Regex PairCodeRe = new Regex(@"配对码\s+([A-Z0-9]{6})", RegexOptions.Compiled);
    private static readonly Regex PayloadRe = new Regex(@"(linkok://pair\S+)", RegexOptions.Compiled);
    private static readonly Regex PairedRe = new Regex(@"paired\s+(yes|no)", RegexOptions.Compiled);

    private void ApplyHubLine(string line)
    {
        AppendLog(line);

        Match payload = PayloadRe.Match(line);
        if (payload.Success) ShowPairing(payload.Groups[1].Value);

        Match paired = PairedRe.Match(line);
        if (paired.Success && paired.Groups[1].Value == "yes")
        {
            // 已经配对过：把二维码区域隐藏，避免误导用户去扫一个旧的码。
            SetStatus("已就绪 · 等待手机连接", Color.FromArgb(0x1B, 0x6C, 0x4B));
        }

        // 端口被占用是首次部署最常见的失败，且原文案只讲"关掉占用程序"，
        // 用户并不知道是哪个程序。这里明确指出可能是上一个 LinkOK 没退干净。
        if (line.Contains("EADDRINUSE") || line.Contains("已被占用") || line.Contains("端口"))
        {
            if (line.Contains("占用"))
            {
                SetStatus("端口被占用 · 无法启动", Color.Firebrick);
                ShowPortInUseHelp();
            }
        }

        if (line.Contains("helper ready"))
        {
            AppendLog("[就绪] 剪贴板监听已启动");
        }
        if (line.Contains("Hub listening"))
        {
            Match m = Regex.Match(line, @"http://[\d\.]+:(\d+)");
            if (m.Success)
            {
                SetStatus("运行中 · 端口 " + m.Groups[1].Value, Color.FromArgb(0x1B, 0x6C, 0x4B));
            }
        }
        if (line.Contains("paired device found"))
        {
            SetStatus("已配对 · 等待手机连接", Color.FromArgb(0x1B, 0x6C, 0x4B));
            // 不要在已配对时留一个空白二维码框 —— 看起来像加载失败。
            // 换成一张"已连接"状态图，并给出重新配对的指引。
            ShowPairedPlaceholder();
        }
    }

    /// <summary>
    /// 已配对时的占位图：一个对勾，替换掉空白二维码框。
    /// 空框会被误读成"二维码没加载出来"。
    /// </summary>
    private void ShowPairedPlaceholder()
    {
        _qrHint.Text = "已配对 · 手机打开 LinkOK 即可连接";
        _codeLabel.Text = "";
        _payloadBox.Text = "";
        try
        {
            if (_qrBitmap != null) { _qrBitmap.Dispose(); _qrBitmap = null; }
            var bmp = new Bitmap(_qrBox.Width > 0 ? _qrBox.Width : 240,
                                 _qrBox.Height > 0 ? _qrBox.Height : 240);
            using (var g = Graphics.FromImage(bmp))
            using (var pen = new Pen(Color.FromArgb(0x1B, 0x6C, 0x4B), 10f))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.White);
                int w = bmp.Width, h = bmp.Height;
                // 画一个对勾
                g.DrawLines(pen, new[]
                {
                    new Point((int)(w * 0.24), (int)(h * 0.52)),
                    new Point((int)(w * 0.44), (int)(h * 0.70)),
                    new Point((int)(w * 0.78), (int)(h * 0.32)),
                });
            }
            _qrBitmap = bmp;
            _qrBox.Image = bmp;
        }
        catch (Exception ex)
        {
            AppendLog("[警告] 状态图渲染失败：" + ex.Message);
        }
    }

    private void ShowPairing(string payload)
    {
        if (payload == _currentPayload) return;
        _currentPayload = payload;

        Match code = PairCodeRe.Match(_logBox.Text);
        _payloadBox.Text = payload;
        if (code.Success) _codeLabel.Text = code.Groups[1].Value;

        try
        {
            Bitmap bmp = QrRenderer.Render(payload, 240);
            if (bmp != null)
            {
                if (_qrBitmap != null) _qrBitmap.Dispose();
                _qrBitmap = bmp;
                _qrBox.Image = _qrBitmap;
                _qrHint.Text = "用手机 LinkOK 扫码配对";
            }
            else
            {
                _qrBox.Image = null;
                _qrHint.Text = "二维码生成失败，请复制下面的链接粘贴到手机";
            }
        }
        catch (Exception ex)
        {
            AppendLog("[警告] 二维码渲染失败：" + ex.Message);
            _qrHint.Text = "二维码生成失败，请复制下面的链接";
        }
    }

    private void SetStatus(string text, Color color)
    {
        _statusLabel.Text = text;
        _statusLabel.ForeColor = color;
        if (_tray != null) _tray.Text = AppInfo.Title + " · " + Truncate(text, 50);
    }

    private static string Truncate(string s, int max)
    {
        return s.Length <= max ? s : s.Substring(0, max);
    }

    private void AppendLog(string line)
    {
        // 只保留尾部，避免长时间运行后文本框无限增长。
        if (_logBox.TextLength > 60000)
        {
            _logBox.Text = _logBox.Text.Substring(_logBox.TextLength - 30000);
        }
        _logBox.AppendText(line + Environment.NewLine);
    }

    private void SafeInvoke(Action action)
    {
        if (IsDisposed) return;
        try
        {
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void CopyPayload()
    {
        // 已配对时窗口里没有当前码，但用户仍可能想复制一个去配新手机/重装后的手机。
        // 之前这里直接 return，按钮点了没反应，看起来像坏了。
        if (string.IsNullOrEmpty(_currentPayload))
        {
            string spare = ReadLatestPayloadFromLog();
            if (string.IsNullOrEmpty(spare))
            {
                MessageBox.Show(
                    "现在没有可用的配对链接。\n\n" +
                    "配对码有效期只有 120 秒，过期就没有了。\n" +
                    "点「换个配对码」可以生成一个新的。",
                    AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            ShowPairing(spare);
        }

        try
        {
            Clipboard.SetText(_currentPayload);
            _copyButton.Text = "已复制 ✓";
            var timer = new System.Windows.Forms.Timer { Interval = 1500 };
            timer.Tick += (s, e) => { _copyButton.Text = "复制配对链接"; timer.Stop(); timer.Dispose(); };
            timer.Start();
        }
        catch (Exception ex)
        {
            AppendLog("[警告] 复制失败：" + ex.Message);
        }
    }

    private void OpenSettings()
    {
        string url = "http://127.0.0.1:8787/";
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppendLog("[警告] 无法打开浏览器：" + ex.Message);
        }
    }

    /// <summary>
    /// 端口被占用时的可操作提示。
    ///
    /// Hub 自己的日志只说"请关闭占用该端口的程序"，但不说是哪个程序 ——
    /// 而这台机器上十次有九次是上一个 LinkOK 没有完全退出。
    /// </summary>
    private void ShowPortInUseHelp()
    {
        if (_portHelpShown) return;
        _portHelpShown = true;
        MessageBox.Show(
            "端口 8787 被占用了，LinkOK 没能启动。\n\n" +
            "最常见的原因：已经有一个 LinkOK 在后台运行。\n\n" +
            "解决办法（任选）：\n" +
            "  1. 在任务管理器里结束所有 LinkOK.exe 和 node.exe，然后重开\n" +
            "  2. 打开命令行执行：\n" +
            "       taskkill /F /IM LinkOK.exe\n" +
            "       taskkill /F /IM node.exe\n" +
            "  3. 想换个端口：在命令行里运行\n" +
            "       LinkOK.exe --port 8790\n\n" +
            "点「打开设置页」之前请先解决端口占用，否则页面打不开。",
            AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private bool _portHelpShown;

    private void RequestNewCode()
    {
        // 主动向 Hub 要一个新配对码。
        //
        // 之前这里只是「把已有的 payload 复制到剪贴板」，而 Hub 已配对时
        // banner() 根本不打印配对链接 —— 于是 _currentPayload 恒为空，
        // 二维码区是空白白框，「复制配对链接」复制不到东西，「换个配对码」
        // 也换不出新码。手机一旦丢失 token（重装、清数据、换机），
        // 在界面上就再也无法重新配对。
        //
        // 正确做法：调用 Hub 的 POST /api/pairing-code 现场生成一个。
        // 该端点需要 Bearer Token，而 Token 只有 Hub 自己知道 —— 所以让
        // **Hub 自己**去调（我们通过一个内部信号触发），或者退而求其次：
        // 用 Hub 写入日志的配对码（已配对时也会写，见下）。
        //
        // 采用后者：Hub 的 banner 已改为「无论是否配对都记录一个新码」，
        // 这里只要重新读一次日志即可拿到最新的码。
        string payload = ReadLatestPayloadFromLog();
        if (!string.IsNullOrEmpty(payload))
        {
            ShowPairing(payload);
            CopyPayload();
            MessageBox.Show(
                "已生成新的配对链接并复制到剪贴板。\n\n" +
                "配对码有效期 120 秒。手机打开 LinkOK 扫码即可；\n" +
                "扫不了就把链接粘贴到手机（别手打，输入法会吞掉 :// 和 ?&=）。",
                AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        MessageBox.Show(
            "没能拿到配对链接。\n\n" +
            "请确认 LinkOK 正在运行（状态行不是「已停止」），然后重试。\n" +
            "仍然不行的话，重新双击 LinkOK.exe 重启它。",
            AppInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    /// <summary>
    /// 从 Hub 的日志文件里取最后一个 linkok://pair 载荷。
    ///
    /// 为什么走日志而不是 HTTP：`POST /api/pairing-code` 需要 Bearer Token，
    /// 而 Token 存在 Hub 的 device.json 里；让 GUI 去读它等于把凭据复制到
    /// 另一个进程，没必要。Hub 每次启动都会往日志写一行配对链接（无论是否
    /// 已配对），读那一行更简单，也不扩大攻击面。
    /// </summary>
    private string ReadLatestPayloadFromLog()
    {
        try
        {
            string dataDir = Environment.GetEnvironmentVariable("LINKOK_DATA_DIR");
            if (string.IsNullOrEmpty(dataDir)) dataDir = Path.Combine(_root, ".pc-data");
            string logDir = Path.Combine(dataDir, "logs");
            if (!Directory.Exists(logDir)) return null;

            string newest = null;
            DateTime newestAt = DateTime.MinValue;
            foreach (string f in Directory.GetFiles(logDir, "hub-*.log"))
            {
                DateTime t = File.GetLastWriteTimeUtc(f);
                if (t > newestAt) { newestAt = t; newest = f; }
            }
            if (newest == null) return null;

            // 文件可能正在被写入，用共享读打开。
            string lastMatch = null;
            using (var fs = new FileStream(newest, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var reader = new StreamReader(fs, Encoding.UTF8))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.IndexOf("linkok://pair", StringComparison.Ordinal) >= 0)
                    {
                        lastMatch = line;
                    }
                }
            }
            if (lastMatch == null) return null;

            int idx = lastMatch.IndexOf("linkok://pair", StringComparison.Ordinal);
            string tail = lastMatch.Substring(idx).Trim();
            // 载荷以空白结尾，截到第一个空白字符。
            int end = 0;
            while (end < tail.Length && !char.IsWhiteSpace(tail[end])) end++;
            return tail.Substring(0, end);
        }
        catch (Exception ex)
        {
            AppendLog("[警告] 读取配对链接失败：" + ex.Message);
            return null;
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_closingForReal && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            if (_tray != null) _tray.Visible = true;
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
            }
            if (_qrBitmap != null) _qrBitmap.Dispose();
            if (_hub != null)
            {
                try { if (!_hub.HasExited) _hub.Kill(); } catch { }
                _hub.Dispose();
            }
        }
        base.Dispose(disposing);
    }
}

/// <summary>
/// 用 pc/helper/QrCode.cs 里的编码器把 payload 渲染成位图。
///
/// 编译时把 pc/helper/QrCode.cs 一起交给 csc（见 scripts/env.ps1 的 Build-Launcher），
/// 所以这里是**直接引用**，不是反射 —— 反射会掩盖类型改名，编译期就该报错。
/// </summary>
internal static class QrRenderer
{
    public static Bitmap Render(string payload, int size)
    {
        LinkOK.Helper.QrCode qr = LinkOK.Helper.QrCode.EncodeText(payload ?? string.Empty);
        if (qr == null) return null;

        int modules = qr.Size;
        if (modules <= 0) return null;

        const int quiet = 4;
        int total = modules + quiet * 2;
        int scale = Math.Max(1, size / total);
        int px = total * scale;

        Bitmap bmp = new Bitmap(px, px, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        using (var dark = new SolidBrush(Color.Black))
        using (var light = new SolidBrush(Color.White))
        {
            g.SmoothingMode = SmoothingMode.None;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.FillRectangle(light, 0, 0, px, px);
            for (int y = 0; y < modules; y++)
            {
                for (int x = 0; x < modules; x++)
                {
                    // 索引器签名是 this[x, y]
                    if (!qr[x, y]) continue;
                    g.FillRectangle(dark,
                        (x + quiet) * scale, (y + quiet) * scale, scale, scale);
                }
            }
        }
        return bmp;
    }
}


