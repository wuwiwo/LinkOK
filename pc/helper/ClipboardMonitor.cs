// LinkOK helper — clipboard monitoring with echo suppression.
//
// SPEC §5.2: PC Captures come from the clipboard (PrtSc, Win+Shift+S, browser "copy image",
// WeChat copy image). WeChat in particular tends to put a *bitmap* on the clipboard rather
// than a DIB, which is why CF_BITMAP is read as well.
//
// SPEC §4 invariant 1: anything LinkOK itself wrote must never be reported back as a user
// copy. The helper records the hash of every write it performs and drops the matching
// WM_CLIPBOARDUPDATE. Reading still happens on a worker thread so the UI thread that must
// keep pumping WM_CLIPBOARDUPDATE never blocks on a slow clipboard owner.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace LinkOK.Helper
{
    internal sealed class ClipboardMonitor : IDisposable
    {
        /// <summary>How long an echo record stays valid. Clipboard updates arrive immediately.</summary>
        private static readonly TimeSpan EchoWindow = TimeSpan.FromSeconds(15);

        private readonly IntPtr _owner;
        private readonly string _tempDir;
        private readonly Queue<ClipboardReadResult> _queue = new Queue<ClipboardReadResult>();
        private readonly HashSet<string> _emittedImageHashes = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> _emittedTextHashes = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, DateTime> _echoes = new Dictionary<string, DateTime>(StringComparer.Ordinal);
        private readonly object _gate = new object();

        private Thread _worker;
        private volatile bool _running;
        private volatile bool _paused;
        private bool _disposed;

        // A self-write whose read-back bytes cannot be predicted (CF_DIB re-encode) is
        // suppressed positionally: the next clipboard update after the write is ours.
        private DateTime _selfWriteUntil = DateTime.MinValue;
        private int _selfWriteImageSkips;
        private int _selfWriteTextSkips;

        public ClipboardMonitor(IntPtr owner, string tempDir)
        {
            _owner = owner;
            _tempDir = tempDir;
        }

        public event EventHandler<ClipboardImageEvent> ImageArrived;
        public event EventHandler<ClipboardTextEvent> TextArrived;
        public event EventHandler<HelperError> Failed;

        public bool Paused
        {
            get { return _paused; }
            set { _paused = value; }
        }

        public void Start()
        {
            if (_running) return;
            _running = true;
            _worker = new Thread(WorkerLoop);
            _worker.IsBackground = true;
            _worker.Name = "LinkOK.ClipboardReader";
            _worker.Start();
        }

        public void Stop()
        {
            _running = false;
            lock (_gate) Monitor.PulseAll(_gate);
        }

        /// <summary>Called from the message window WndProc on WM_CLIPBOARDUPDATE.</summary>
        public void NotifyUpdate()
        {
            lock (_gate)
            {
                if (_queue.Count > 4) _queue.Dequeue(); // coalesce bursts; latest state wins
                _queue.Enqueue(null);
                Monitor.PulseAll(_gate);
            }
        }

        private void WorkerLoop()
        {
            while (_running)
            {
                lock (_gate)
                {
                    while (_running && _queue.Count == 0) Monitor.Wait(_gate, 500);
                    _queue.Clear();
                }
                if (!_running) return;
                if (_paused) continue;

                try
                {
                    ProcessCurrentClipboard();
                }
                catch (ClipboardBusyException ex)
                {
                    RaiseError("clipboard-busy", "剪贴板被其他程序占用，本次内容未能读取：" + ex.Message);
                }
                catch (Exception ex)
                {
                    RaiseError("internal", "读取剪贴板失败：" + Paths.Describe(ex));
                }
            }
        }

        private void ProcessCurrentClipboard()
        {
            ClipboardReadResult result = Clipboard.Read(_owner);
            if (result.IsEmpty) return;

            bool anyEcho = false;

            // Consume both positional guards up front. They are armed *before* a self-write,
            // so the very next update is the read-back of our own write; taking them here
            // (rather than inside the branches) stops a guard from lingering when the update
            // happens not to carry that content type.
            bool skipImage = result.HasImage && ConsumeSelfWriteImage();
            bool skipText = result.HasText && ConsumeSelfWriteText();

            if (result.HasImage && !_paused)
            {
                string sha = Hashing.Sha256Hex(result.ImagePng);
                // Hash match = the exact bytes we wrote; positional = a write whose read-back
                // an app re-encoded on the way through the clipboard.
                if (skipImage || IsEcho("i:" + sha))
                {
                    lock (_gate) _emittedImageHashes.Add(sha);
                    anyEcho = true;
                    Log.Info("clipboard image echo suppressed: " + sha.Substring(0, 12));
                }
                else
                {
                    EmitImage(result, sha);
                }
            }

            if (result.HasText && !_paused)
            {
                bool truncated;
                string text = Clipboard.CapText(result.Text, out truncated);
                string hash = Hashing.Sha256HexOfText(text);
                if (skipText || IsEcho("t:" + hash))
                {
                    lock (_gate) _emittedTextHashes.Add(hash);
                    anyEcho = true;
                    Log.Info("clipboard text echo suppressed: " + hash.Substring(0, 12));
                }
                else
                {
                    bool isNew;
                    lock (_gate) isNew = _emittedTextHashes.Add(hash);
                    if (isNew)
                    {
                        EventHandler<ClipboardTextEvent> handler = TextArrived;
                        if (handler != null)
                        {
                            handler(this, new ClipboardTextEvent(text, hash, text.Length, truncated));
                        }
                    }
                    else
                    {
                        Log.Info("clipboard text duplicate suppressed: " + hash.Substring(0, 12));
                    }
                }
            }

            // An echo arrives as one update carrying both the image and its accompanying text;
            // absorb the rest of that update too.
            if (anyEcho)
            {
                lock (_gate)
                {
                    _selfWriteImageSkips = 0;
                    _selfWriteTextSkips = 0;
                }
            }
        }

        /// <summary>
        /// Clipboards sometimes report the same image twice with different bytes
        /// (CF_DIB and CF_DIBV5 in separate updates). The emitted-content hash set keeps
        /// "同一张图只投递一次" true without needing to decode the pixels.
        /// </summary>
        private string ImageEchoKey(byte[] png)
        {
            return "i:" + Hashing.Sha256Hex(png);
        }

        /// <summary>
        /// Arm the positional echo guard. Used when the helper writes a format whose exact
        /// read-back bytes it cannot predict (an app may re-encode the DIB), so the very next
        /// clipboard update following the write is dropped no matter what it contains.
        /// </summary>
        public void ArmSelfWriteImage()
        {
            lock (_gate)
            {
                _selfWriteUntil = DateTime.UtcNow + EchoWindow;
                _selfWriteImageSkips = 1;
                _selfWriteTextSkips = 1;
            }
        }

        public void ArmSelfWriteText()
        {
            lock (_gate)
            {
                _selfWriteUntil = DateTime.UtcNow + EchoWindow;
                _selfWriteTextSkips = 1;
            }
        }

        /// <summary>Disarm the guards when the write they were armed for did not happen.</summary>
        public void CancelSelfWrite()
        {
            lock (_gate)
            {
                _selfWriteImageSkips = 0;
                _selfWriteTextSkips = 0;
                _selfWriteUntil = DateTime.MinValue;
            }
        }

        private bool ConsumeSelfWriteImage()
        {
            lock (_gate)
            {
                if (_selfWriteImageSkips <= 0) return false;
                if (DateTime.UtcNow > _selfWriteUntil)
                {
                    _selfWriteImageSkips = 0;
                    _selfWriteTextSkips = 0;
                    return false;
                }
                _selfWriteImageSkips--;
                return true;
            }
        }

        private bool ConsumeSelfWriteText()
        {
            lock (_gate)
            {
                if (_selfWriteTextSkips <= 0) return false;
                if (DateTime.UtcNow > _selfWriteUntil)
                {
                    _selfWriteImageSkips = 0;
                    _selfWriteTextSkips = 0;
                    return false;
                }
                _selfWriteTextSkips--;
                return true;
            }
        }

        private void EmitImage(ClipboardReadResult result, string sha)
        {
            bool isNew;
            lock (_gate) isNew = _emittedImageHashes.Add(sha);
            if (!isNew)
            {
                Log.Info("clipboard image duplicate suppressed: " + sha.Substring(0, 12));
                return;
            }

            string file = Path.Combine(_tempDir, "linkok-clip-" + sha.Substring(0, 8) + ".png");
            try
            {
                File.WriteAllBytes(file, result.ImagePng);
            }
            catch (Exception ex)
            {
                RaiseError("temp-write", "剪贴板图片落盘失败：" + Paths.Describe(ex));
                return;
            }

            EventHandler<ClipboardImageEvent> handler = ImageArrived;
            if (handler != null)
            {
                handler(this, new ClipboardImageEvent(file, sha, result.Width, result.Height,
                    result.ImagePng.Length, result.Source));
            }
        }

        private bool IsEcho(string key)
        {
            lock (_gate)
            {
                DateTime stamp;
                if (!_echoes.TryGetValue(key, out stamp)) return false;
                if (DateTime.UtcNow - stamp > EchoWindow)
                {
                    _echoes.Remove(key);
                    return false;
                }
                _echoes.Remove(key); // one-shot: a later user copy of the same bytes is real
                Log.Info("echo suppressed: " + key);
                return true;
            }
        }

        /// <summary>
        /// Record the content hash of a write so the resulting WM_CLIPBOARDUPDATE is dropped.
        /// PROTOCOL §5.6 / SPEC §4 invariant 1. Must be called before the write, not after.
        /// </summary>
        public void RecordEchoImage(byte[] png)
        {
            Remember("i:" + Hashing.Sha256Hex(png));
        }

        public void RecordEchoText(string text)
        {
            Remember("t:" + Hashing.Sha256HexOfText(text));
        }

        /// <summary>Seed from a PNG file we are about to write (same key as the read path).</summary>
        public void RecordEchoFile(string file)
        {
            try
            {
                Remember("i:" + Hashing.Sha256HexOfFile(file));
            }
            catch (Exception ex)
            {
                Log.Warn("echo seed failed for " + file + ": " + Paths.Describe(ex));
            }
        }

        private void Remember(string key)
        {
            lock (_gate)
            {
                _echoes[key] = DateTime.UtcNow;
                // Drop stale entries; the dictionary is tiny but unbounded without this.
                if (_echoes.Count > 32)
                {
                    List<string> stale = new List<string>();
                    foreach (KeyValuePair<string, DateTime> pair in _echoes)
                    {
                        if (DateTime.UtcNow - pair.Value > EchoWindow) stale.Add(pair.Key);
                    }
                    foreach (string key2 in stale) _echoes.Remove(key2);
                }
            }
        }

        /// <summary>
        /// Forget emitted-content hashes. Called when the user clears the clipboard, so
        /// re-copying the same screenshot later is delivered again instead of silently dropped.
        /// </summary>
        public void ResetEmitted()
        {
            lock (_gate)
            {
                _emittedImageHashes.Clear();
                _emittedTextHashes.Clear();
            }
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
            Stop();
            if (_worker != null) _worker.Join(1000);
        }
    }

    internal sealed class ClipboardImageEvent : EventArgs
    {
        public ClipboardImageEvent(string file, string sha256, int width, int height, int bytes,
            ClipboardImageSource source)
        {
            File = file;
            Sha256 = sha256;
            Width = width;
            Height = height;
            Bytes = bytes;
            Source = source;
        }

        public string File { get; private set; }
        public string Sha256 { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }
        public int Bytes { get; private set; }
        public ClipboardImageSource Source { get; private set; }
    }

    internal sealed class ClipboardTextEvent : EventArgs
    {
        public ClipboardTextEvent(string text, string sha256, int chars, bool truncated)
        {
            Text = text;
            Sha256 = sha256;
            Chars = chars;
            Truncated = truncated;
        }

        public string Text { get; private set; }
        public string Sha256 { get; private set; }
        public int Chars { get; private set; }
        public bool Truncated { get; private set; }
    }

    internal sealed class HelperError : EventArgs
    {
        public HelperError(string code, string message)
        {
            Code = code;
            Message = message;
        }

        public string Code { get; private set; }
        public string Message { get; private set; }
    }
}
