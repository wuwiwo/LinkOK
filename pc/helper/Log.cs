// LinkOK helper — process-wide diagnostics.
//
// stdout is reserved for the stdio protocol (PROTOCOL.md §11) and must carry
// nothing but one JSON object per line. Diagnostics therefore go to stderr and
// to a rolling daily log file.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace LinkOK.Helper
{
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static string _path;
        private static bool _fileBroken;

        /// <summary>
        /// Resolve the log file, creating its directory. Failure is not fatal:
        /// the helper still works with stderr only.
        /// </summary>
        public static void Configure(string explicitPath)
        {
            lock (Gate)
            {
                _path = null;
                _fileBroken = false;
                try
                {
                    if (!string.IsNullOrEmpty(explicitPath))
                    {
                        _path = explicitPath;
                    }
                    else
                    {
                        string dir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "LinkOK", "logs");
                        Directory.CreateDirectory(dir);
                        _path = Path.Combine(dir, "helper-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log");
                    }
                    string parent = Path.GetDirectoryName(_path);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                }
                catch (Exception ex)
                {
                    _path = null;
                    _fileBroken = true;
                    WriteDirect("log-path-unavailable: " + Paths.Describe(ex));
                }
            }
        }

        public static void Info(string message)
        {
            Write("INFO ", message);
        }

        public static void Warn(string message)
        {
            Write("WARN ", message);
        }

        public static void Error(string message)
        {
            Write("ERROR", message);
        }

        private static void Write(string level, string message)
        {
            string line = string.Format("{0:yyyy-MM-dd HH:mm:ss.fff} {1} {2}",
                DateTime.Now, level, message);
            lock (Gate)
            {
                WriteDirect(line);
                if (_path == null || _fileBroken) return;
                try
                {
                    File.AppendAllText(_path, line + "\r\n", new UTF8Encoding(false));
                }
                catch (Exception)
                {
                    // A failing log must never take the helper down, but it is
                    // said once on stderr so it cannot be mistaken for silence.
                    _fileBroken = true;
                    WriteDirect("log-file-broken: " + _path);
                }
            }
        }

        private static void WriteDirect(string line)
        {
            try
            {
                Console.Error.WriteLine(line);
                Console.Error.Flush();
            }
            catch (Exception)
            {
                // stderr itself can be closed by the parent; nothing to do.
            }
        }
    }

    /// <summary>Exception → one-line description, for both logs and error events.</summary>
    internal static class Paths
    {
        public static string Describe(Exception ex)
        {
            if (ex == null) return "(null)";
            string text = ex.GetType().Name + ": " + ex.Message;
            if (ex.InnerException != null)
            {
                text += " <- " + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message;
            }
            return text.Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>
        /// The system screenshots folder.
        ///
        /// SPEC §5.2 / PROTOCOL §7: resolve
        /// HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
        /// value {374DE290-123F-4565-9164-39C4925E467B}, then expand environment
        /// variables (the registry stores REG_EXPAND_SZ such as %USERPROFILE%\Pictures\Screenshots).
        ///
        /// LINKOK_SCREENSHOT_DIR overrides it, which is what the integration tests use.
        /// </summary>
        public static string ResolveScreenshotDir()
        {
            string overrideDir = Environment.GetEnvironmentVariable("LINKOK_SCREENSHOT_DIR");
            if (!string.IsNullOrEmpty(overrideDir)) return overrideDir.Trim('"');

            const string keyPath = @"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders";
            const string valueName = "{374DE290-123F-4565-9164-39C4925E467B}";
            try
            {
                using (Microsoft.Win32.RegistryKey key =
                    Microsoft.Win32.Registry.CurrentUser.OpenSubKey(keyPath, false))
                {
                    if (key != null)
                    {
                        object raw = key.GetValue(valueName, null,
                            Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames);
                        string value = raw as string;
                        if (!string.IsNullOrEmpty(value))
                        {
                            string expanded = Environment.ExpandEnvironmentVariables(value);
                            Log.Info("screenshot dir from registry: " + expanded);
                            return expanded;
                        }
                        Log.Warn("registry value " + valueName + " is absent");
                    }
                    else
                    {
                        Log.Warn("registry key User Shell Folders is absent");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn("registry lookup failed: " + Describe(ex));
            }

            string fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "Screenshots");
            Log.Warn("falling back to " + fallback);
            return fallback;
        }

        /// <summary>Temp directory for clipboard PNG spills (PROTOCOL §11: file, never binary on stdio).</summary>
        /// <remarks>
        /// Resolution order, first writable one wins:
        ///   1. LINKOK_HELPER_TMP — set by the Hub to its own data dir.
        ///   2. &lt;LINKOK_DATA_DIR&gt;\tmp — when the helper is launched by hand for debugging.
        ///   3. %LOCALAPPDATA%\LinkOK\tmp — the same place the Hub uses by default.
        ///   4. %TEMP%\LinkOK — last resort; often unwritable under a restricted profile.
        ///
        /// The old code went straight to %TEMP% and threw UnauthorizedAccessException before
        /// the process ever emitted <c>ready</c>, so the Hub saw a crash loop with no clue why.
        /// </remarks>
        public static string EnsureTempDir()
        {
            string custom = Environment.GetEnvironmentVariable("LINKOK_HELPER_TMP");
            string[] candidates = new string[]
            {
                custom,
                Combine(Environment.GetEnvironmentVariable("LINKOK_DATA_DIR"), "tmp"),
                Combine(
                    Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "LinkOK"),
                    "tmp"),
                Path.Combine(Path.GetTempPath(), "LinkOK")
            };

            string chosen = FirstWritable(candidates);
            if (chosen == null)
            {
                throw new IOException(
                    "没有可写的临时目录。请设置 LINKOK_HELPER_TMP 指向一个可写路径。");
            }

            // Say which candidate won. A silent fallback to %TEMP% would otherwise be
            // indistinguishable from the Hub-supplied directory in the logs.
            if (!string.IsNullOrEmpty(custom) && string.Equals(chosen, custom, StringComparison.OrdinalIgnoreCase))
            {
                Log.Info("temp dir (LINKOK_HELPER_TMP): " + chosen);
            }
            else
            {
                Log.Warn("LINKOK_HELPER_TMP unusable; temp dir fell back to: " + chosen);
            }
            return chosen;
        }

        private static string Combine(string root, string leaf)
        {
            return string.IsNullOrEmpty(root) ? null : Path.Combine(root, leaf);
        }

        /// <summary>Return the first candidate that exists as a writable directory, creating it if needed.</summary>
        private static string FirstWritable(params string[] candidates)
        {
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate)) continue;
                try
                {
                    Directory.CreateDirectory(candidate);
                    // CreateDirectory succeeding is not proof; probe with a real file.
                    string probe = Path.Combine(candidate, ".write-probe");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return candidate;
                }
                catch (Exception ex)
                {
                    Log.Warn("temp candidate unusable (" + candidate + "): " + Paths.Describe(ex));
                }
            }
            return null;
        }
    }
}
