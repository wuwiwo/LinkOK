// LinkOK helper — process entry point and the stdio protocol (PROTOCOL.md §11).
//
// One JSON object per line, UTF-8, Chinese not escaped. stdout carries nothing else.
// The message pump runs on the main thread because the clipboard listener, the tray
// callback and the QR window all need a live pump; stdin is read on its own thread.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace LinkOK.Helper
{
    internal static class Program
    {
        internal const string Version = "0.1.0";

        private const string MutexName = @"Local\LinkOK.Helper.SingleInstance";

        /// <summary>Set to 1 once {"cmd":"ready"…} has been emitted; guards double ready.</summary>
        private static int _readySent;

        private static HelperRuntime _runtime;

        [STAThread]
        private static int Main(string[] args)
        {
            // Single instance. A second launch must not fight over the tray icon or clipboard.
            bool createdNew;
            Mutex mutex = null;
            try
            {
                mutex = new Mutex(true, MutexName, out createdNew);
            }
            catch (Exception ex)
            {
                Log.Configure(null);
                Log.Error("mutex creation failed: " + Paths.Describe(ex));
                createdNew = true; // run anyway; losing the guard beats refusing to start
            }

            if (!createdNew)
            {
                Log.Configure(null);
                Log.Warn("another LinkOK helper instance is already running; exiting");
                try
                {
                    Console.Error.WriteLine("LinkOK helper: 已有实例在运行，本进程退出。");
                }
                catch (Exception ex)
                {
                    Log.Warn("stderr unavailable: " + Paths.Describe(ex));
                }
                return 2;
            }

            // The Hub talks UTF-8; never let a localized OEM code page mangle Chinese.
            bool stdoutRedirected = IsStdoutRedirected();
            if (!stdoutRedirected)
            {
                try
                {
                    Console.InputEncoding = new UTF8Encoding(false);
                }
                catch (Exception ex)
                {
                    Log.Configure(null);
                    Log.Warn("console encoding not settable: " + Paths.Describe(ex));
                }
            }

            Log.Configure(Environment.GetEnvironmentVariable("LINKOK_HELPER_LOG"));
            Log.Info("LinkOK helper " + Version + " starting (pid " + System.Diagnostics.Process.GetCurrentProcess().Id + ")");

            // Console.OutputEncoding requires a real console; with redirected stdio (which is
            // how the Hub always runs us) setting it throws, and that is expected, so the
            // warning is only noise. All stdio I/O below uses explicit UTF-8 instead. When a
            // console *is* attached, setting the code page keeps ad-hoc runs readable.
            if (!IsStdoutRedirected())
            {
                try
                {
                    Console.OutputEncoding = new UTF8Encoding(false);
                }
                catch (IOException)
                {
                    // Not fatal: output still goes out as UTF-8 through the explicit encoder.
                }
                catch (Exception ex)
                {
                    Log.Warn("console encoding not settable: " + Paths.Describe(ex));
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            _runtime = new HelperRuntime();
            try
            {
                _runtime.Start();
            }
            catch (Exception ex)
            {
                Log.Error("runtime start failed: " + Paths.Describe(ex));
                _runtime.ReportError("internal", "helper 启动失败：" + Paths.Describe(ex));
                return 1;
            }

            Thread reader = new Thread(StdinLoop);
            reader.IsBackground = true;
            reader.Name = "LinkOK.StdinReader";
            reader.Start();

            try
            {
                Application.Run(); // returns after Application.ExitThread()
            }
            finally
            {
                _runtime.Shutdown();
                Log.Info("helper exited");
                try
                {
                    if (mutex != null) mutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                    // We did not own it (creation failed above); nothing to release.
                }
                if (mutex != null) mutex.Dispose();
            }
            return 0;
        }

        /// <summary>
        /// True when stdout is a file or pipe rather than a console, i.e. how the Hub runs us.
        /// GetFileType returns FILE_TYPE_PIPE / FILE_TYPE_DISK in that case.
        /// </summary>
        private static bool IsStdoutRedirected()
        {
            try
            {
                IntPtr handle = GetStdHandle(-11); // STD_OUTPUT_HANDLE
                if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return true;
                uint type = GetFileType(handle);
                return type != FileTypeChar;
            }
            catch (Exception ex)
            {
                Log.Warn("stdout probe failed: " + Paths.Describe(ex));
                return true;
            }
        }

        private const uint FileTypeChar = 0x0002;

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int stdHandle);

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetFileType(IntPtr handle);

        // ── stdin ─────────────────────────────────────────────────────────────

        private static void StdinLoop()
        {
            Stream input = Console.OpenStandardInput();
            // Read bytes and split on '\n' ourselves: Console.In is not guaranteed to be
            // UTF-8 and mangles Chinese payloads on some systems.
            List<byte> buffer = new List<byte>(1024);
            byte[] chunk = new byte[8192];
            try
            {
                while (true)
                {
                    int read = input.Read(chunk, 0, chunk.Length);
                    if (read <= 0) break; // EOF: the Hub closed us
                    for (int i = 0; i < read; i++)
                    {
                        byte b = chunk[i];
                        if (b == (byte)'\n')
                        {
                            string line = Encoding.UTF8.GetString(buffer.ToArray()).Trim();
                            buffer.Clear();
                            if (line.Length > 0) HandleLine(line);
                        }
                        else
                        {
                            buffer.Add(b);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("stdin read failed: " + Paths.Describe(ex));
            }

            if (buffer.Count > 0)
            {
                string tail = Encoding.UTF8.GetString(buffer.ToArray()).Trim();
                if (tail.Length > 0) HandleLine(tail);
            }

            Log.Info("stdin closed; shutting down");
            _runtime.RequestQuit(false);
        }

        private static void HandleLine(string line)
        {
            Dictionary<string, object> message;
            try
            {
                message = JsonReader.ParseObject(line);
            }
            catch (JsonException ex)
            {
                _runtime.ReportError("bad-json", "无法解析协议行：" + ex.Message);
                return;
            }
            catch (Exception ex)
            {
                _runtime.ReportError("bad-json", "无法解析协议行：" + Paths.Describe(ex));
                return;
            }

            string command = JsonReader.Str(message, "cmd");
            if (string.IsNullOrEmpty(command))
            {
                _runtime.ReportError("bad-command", "缺少 cmd 字段：" + Clip(line, 200));
                return;
            }

            try
            {
                switch (command)
                {
                    case "start":
                        _runtime.StartMonitors();
                        break;
                    case "set-paused":
                        _runtime.SetPaused(JsonReader.Bool(message, "paused", false));
                        break;
                    case "show-qr":
                        _runtime.ShowQr(JsonReader.Str(message, "payload"));
                        break;
                    case "hide-qr":
                        _runtime.HideQr();
                        break;
                    case "notify":
                        _runtime.Notify(
                            JsonReader.Str(message, "title"),
                            JsonReader.Str(message, "body"),
                            JsonReader.Str(message, "thumbFile"));
                        break;
                    case "set-tray-state":
                        _runtime.SetTrayState(JsonReader.Str(message, "state"),
                            JsonReader.Str(message, "device"));
                        break;
                    case "set-clipboard-image":
                        _runtime.SetClipboardImage(JsonReader.Str(message, "file"));
                        break;
                    case "set-clipboard-text":
                        _runtime.SetClipboardText(JsonReader.Str(message, "text"));
                        break;
                    case "quit":
                        _runtime.RequestQuit(true);
                        return;
                    default:
                        _runtime.ReportError("bad-command", "未知命令：" + Clip(command, 80));
                        return;
                }
            }
            catch (Exception ex)
            {
                Log.Error("command '" + command + "' threw: " + Paths.Describe(ex));
                _runtime.ReportError("internal", "执行 " + command + " 失败：" + Paths.Describe(ex));
            }
        }

        private static string Clip(string text, int max)
        {
            if (text == null) return string.Empty;
            return text.Length <= max ? text : text.Substring(0, max) + "…";
        }

        // ── stdout ────────────────────────────────────────────────────────────

        private static readonly object WriteGate = new object();

        /// <summary>
        /// Write one protocol line. Serialized because events come from the clipboard worker,
        /// the watcher worker and the UI thread, and a torn line would break the Hub.
        /// </summary>
        public static void Emit(string json)
        {
            lock (WriteGate)
            {
                try
                {
                    Stream stdout = Console.OpenStandardOutput();
                    byte[] bytes = new UTF8Encoding(false).GetBytes(json + "\n");
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
                catch (Exception ex)
                {
                    // stdout gone means the Hub is gone; log it and let the reader notice EOF.
                    Log.Error("stdout write failed: " + Paths.Describe(ex));
                }
            }
        }

        public static void EmitError(string code, string message)
        {
            Log.Error("error event " + code + ": " + message);
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "error");
            writer.Prop("code", code);
            writer.Prop("message", message);
            Emit(writer.Close());
        }

        /// <summary>{"evt":"ready"} once per process, and only when explicitly asked.</summary>
        public static void EmitReadyOnce()
        {
            if (Interlocked.Exchange(ref _readySent, 1) != 0) return;
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "ready");
            writer.Prop("version", Version);
            Emit(writer.Close());
        }

        public static void EmitTrayClick(string item, bool? enabled)
        {
            JsonWriter writer = new JsonWriter();
            writer.Prop("evt", "tray-click");
            writer.Prop("item", item);
            if (enabled.HasValue) writer.Prop("enabled", enabled.Value);
            Emit(writer.Close());
        }
    }
}
