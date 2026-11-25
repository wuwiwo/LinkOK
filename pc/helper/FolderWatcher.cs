// LinkOK helper — screenshot folder watcher.
//
// SPEC §5.2 second source: FileSystemWatcher on the system screenshots folder. The folder
// is resolved dynamically from
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders
//   {374DE290-123F-4565-9164-39C4925E467B}
// because OneDrive frequently redirects it (the machine used to build this reads
// "E:\download"). PROTOCOL §7.
//
// Debounce: a screenshot tool may create the file and then write it in several chunks, and
// FileSystemWatcher fires on creation. Hashing the file at that instant yields a hash of a
// half-written file, so each candidate is only accepted once its size and last-write time
// have stopped changing for a quiet period.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;

namespace LinkOK.Helper
{
    internal sealed class FolderWatcher : IDisposable
    {
        private const string TempSuffix = ".linkok-tmp";

        /// <summary>Candidate files are hashed only after this long without a change.</summary>
        private static readonly TimeSpan QuietPeriod = TimeSpan.FromMilliseconds(350);

        /// <summary>Give up on a file that never settles (a log-like writer) after this long.</summary>
        private static readonly TimeSpan MaxSettleTime = TimeSpan.FromSeconds(20);

        /// <summary>PROTOCOL §9: images only, and 20 MB is the hard ceiling.</summary>
        private const long MaxFileBytes = 20L * 1024 * 1024;

        private static readonly HashSet<string> ImageExtensions = new HashSet<string>(
            new[] { ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".tif", ".tiff" },
            StringComparer.OrdinalIgnoreCase);

        private readonly string _directory;
        private readonly object _gate = new object();
        private readonly Dictionary<string, Candidate> _pending =
            new Dictionary<string, Candidate>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _emittedHashes = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, DateTime> _seenPaths = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private readonly Queue<string> _queue = new Queue<string>();

        /// <summary>
        /// The helper's own spill directory. Clipboard images are written here before the event
        /// is emitted, so if the user ever points the screenshot folder at (or above) the temp
        /// dir the watcher would report LinkOK's own output as a PC Capture — a self-inflicted
        /// Echo. Paths under it are always ignored.
        /// </summary>
        private string _excludedRoot;

        private FileSystemWatcher _watcher;
        private Thread _worker;
        private volatile bool _running;
        private bool _disposed;

        public FolderWatcher(string directory)
        {
            _directory = directory;
        }

        /// <summary>Directory whose contents must never be reported as PC Captures.</summary>
        public string ExcludedRoot
        {
            set { _excludedRoot = value; }
        }

        private bool IsExcluded(string path)
        {
            if (string.IsNullOrEmpty(_excludedRoot) || string.IsNullOrEmpty(path)) return false;
            try
            {
                string root = Path.GetFullPath(_excludedRoot)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string full = Path.GetFullPath(path);
                if (full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                return string.Equals(full, root, StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception ex)
            {
                Log.Warn("exclusion check failed for " + path + ": " + Paths.Describe(ex));
                return false;
            }
        }

        public event EventHandler<FileCapturedEvent> Captured;
        public event EventHandler<HelperError> Failed;

        public string Directory
        {
            get { return _directory; }
        }

        public bool Start(bool scanExisting)
        {
            if (_watcher != null) return true;

            if (string.IsNullOrEmpty(_directory) || !System.IO.Directory.Exists(_directory))
            {
                RaiseError("folder-unavailable", "截图文件夹不存在：" + _directory);
                return false;
            }

            try
            {
                _watcher = new FileSystemWatcher(_directory);
                _watcher.IncludeSubdirectories = true;
                _watcher.InternalBufferSize = 64 * 1024; // bursty screenshot tools
                _watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite
                                        | NotifyFilters.Size | NotifyFilters.CreationTime;
                _watcher.Filter = "*.*";
                _watcher.Created += OnChanged;
                _watcher.Changed += OnChanged;
                _watcher.Renamed += OnRenamed;
                _watcher.Error += OnError;
                _watcher.EnableRaisingEvents = true;
            }
            catch (Exception ex)
            {
                RaiseError("folder-watch-failed",
                    "无法监听截图文件夹 " + _directory + "：" + Paths.Describe(ex));
                if (_watcher != null)
                {
                    _watcher.Dispose();
                    _watcher = null;
                }
                return false;
            }

            _running = true;
            _worker = new Thread(WorkerLoop);
            _worker.IsBackground = true;
            _worker.Name = "LinkOK.FolderWatcher";
            _worker.Start();
            Log.Info("watching screenshots in " + _directory);
            if (scanExisting) RescanExisting(TimeSpan.FromMinutes(10));
            return true;
        }

        private void OnChanged(object sender, FileSystemEventArgs e)
        {
            Enqueue(e.FullPath);
        }

        private void OnRenamed(object sender, RenamedEventArgs e)
        {
            // Screenshot tools that write "<name>.tmp" and then rename land here.
            Enqueue(e.FullPath);
        }

        private void Enqueue(string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            string extension = Path.GetExtension(path);
            if (!ImageExtensions.Contains(extension)) return;
            if (path.EndsWith(TempSuffix, StringComparison.OrdinalIgnoreCase)) return;
            if (IsExcluded(path)) return;
            lock (_gate)
            {
                if (_queue.Count > 512) return; // a huge burst; the initial scan covers it
                _queue.Enqueue(path);
                Monitor.PulseAll(_gate);
            }
        }

        private void OnError(object sender, ErrorEventArgs e)
        {
            Exception ex = e.GetException();
            // A buffer overflow means we missed events; rescan instead of losing captures.
            RaiseError("folder-watch-error", "截图文件夹监听到错误，将重新扫描：" + Paths.Describe(ex));
            try
            {
                RescanExisting(TimeSpan.Zero);
            }
            catch (Exception inner)
            {
                Log.Error("rescan after watcher error failed: " + Paths.Describe(inner));
            }
        }

        private void WorkerLoop()
        {
            List<string> batch = new List<string>();
            while (_running)
            {
                int queued;
                lock (_gate)
                {
                    if (_queue.Count == 0) Monitor.Wait(_gate, 200);
                    while (_queue.Count > 0) batch.Add(_queue.Dequeue());
                    queued = _queue.Count;
                }
                for (int i = 0; i < batch.Count; i++) Touch(batch[i]);
                batch.Clear();

                // Step every candidate that has been quiet long enough.
                List<Candidate> due = new List<Candidate>();
                DateTime now = DateTime.UtcNow;
                lock (_gate)
                {
                    foreach (KeyValuePair<string, Candidate> pair in _pending)
                    {
                        if (now - pair.Value.LastChange >= QuietPeriod) due.Add(pair.Value);
                    }
                    for (int i = 0; i < due.Count; i++) _pending.Remove(due[i].Path);
                }
                for (int i = 0; i < due.Count; i++) TryCapture(due[i]);
                if (queued == 0 && due.Count == 0) Thread.Sleep(20);
            }
        }

        private void Touch(string path)
        {
            try
            {
                FileInfo info = new FileInfo(path);
                if (!info.Exists)
                {
                    lock (_gate) _pending.Remove(path);
                    return;
                }
                lock (_gate)
                {
                    Candidate candidate;
                    if (_pending.TryGetValue(path, out candidate))
                    {
                        candidate.LastChange = DateTime.UtcNow;
                        candidate.FirstSeen = candidate.FirstSeen == DateTime.MinValue
                            ? DateTime.UtcNow : candidate.FirstSeen;
                    }
                    else
                    {
                        _pending[path] = new Candidate(path, DateTime.UtcNow);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn("stat failed for " + path + ": " + Paths.Describe(ex));
            }
        }

        private void TryCapture(Candidate candidate)
        {
            string path = candidate.Path;
            try
            {
                FileInfo info = new FileInfo(path);
                if (!info.Exists) return;
                if (DateTime.UtcNow - candidate.FirstSeen > MaxSettleTime)
                {
                    RaiseError("file-unstable", "文件持续写入，已放弃：" + path);
                    return;
                }
                if (info.Length == 0)
                {
                    Touch(path); // still being created
                    return;
                }
                if (info.Length > MaxFileBytes)
                {
                    RaiseError("file-too-large", string.Format(
                        "截图超过 20MB，未投递：{0}（{1} 字节）", path, info.Length));
                    return;
                }

                // Read with FileShare.ReadWrite so a still-open handle does not block us.
                byte[] bytes;
                using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                           FileShare.ReadWrite | FileShare.Delete))
                {
                    bytes = new byte[fs.Length];
                    int read = 0;
                    while (read < bytes.Length)
                    {
                        int n = fs.Read(bytes, read, bytes.Length - read);
                        if (n <= 0) break;
                        read += n;
                    }
                    if (read != bytes.Length)
                    {
                        Touch(path);
                        return;
                    }
                }

                if (IsExcluded(path)) return;

                string sha = Hashing.Sha256Hex(bytes);
                lock (_gate)
                {
                    if (_emittedHashes.Contains(sha)) return;
                }

                int width = 0, height = 0;
                if (!ImageFile.TryGetDimensions(bytes, out width, out height))
                {
                    Log.Warn("not a decodable image, ignored: " + path);
                    lock (_gate) _emittedHashes.Add(sha); // remember so it is not retried
                    return;
                }

                lock (_gate)
                {
                    if (!_emittedHashes.Add(sha)) return;
                    _seenPaths[path] = DateTime.UtcNow;
                }

                EventHandler<FileCapturedEvent> handler = Captured;
                if (handler != null)
                {
                    handler(this, new FileCapturedEvent(path, sha, width, height, bytes.Length,
                        Path.GetFileName(path)));
                }
            }
            catch (FileNotFoundException)
            {
                // Vanished between events; nothing to do.
            }
            catch (DirectoryNotFoundException)
            {
                Log.Warn("directory vanished while reading " + path);
            }
            catch (IOException ex)
            {
                // Locked or mid-write: requeue rather than lose it.
                Log.Info("file momentarily unreadable, retrying: " + path + " (" + ex.Message + ")");
                Touch(path);
            }
            catch (UnauthorizedAccessException ex)
            {
                RaiseError("file-denied", "无权读取截图：" + path + "（" + ex.Message + "）");
            }
            catch (Exception ex)
            {
                RaiseError("file-failed", "处理截图失败：" + path + "（" + Paths.Describe(ex) + "）");
            }
        }

        /// <summary>
        /// Treat files already present at startup as candidates. SPEC §5.2 only promises new
        /// files, but a screenshot saved while LinkOK was down would otherwise be lost; the
        /// Hub's SHA-256 dedupe makes a startup rescan harmless.
        /// </summary>
        public void RescanExisting(TimeSpan maxAge)
        {
            if (string.IsNullOrEmpty(_directory) || !System.IO.Directory.Exists(_directory)) return;
            DateTime cutoff = maxAge <= TimeSpan.Zero ? DateTime.MinValue : DateTime.UtcNow - maxAge;
            int found = 0;
            try
            {
                foreach (string file in System.IO.Directory.GetFiles(_directory, "*",
                             SearchOption.AllDirectories))
                {
                    try
                    {
                        string extension = Path.GetExtension(file);
                        if (!ImageExtensions.Contains(extension)) continue;
                        if (IsExcluded(file)) continue;
                        FileInfo info = new FileInfo(file);
                        if (!info.Exists || info.Length == 0) continue;
                        if (cutoff != DateTime.MinValue && info.LastWriteTimeUtc < cutoff) continue;
                        found++;
                        Enqueue(file);
                    }
                    catch (Exception ex)
                    {
                        Log.Warn("rescan skipped " + file + ": " + Paths.Describe(ex));
                    }
                }
            }
            catch (Exception ex)
            {
                RaiseError("rescan-failed", "扫描截图文件夹失败：" + Paths.Describe(ex));
            }
            if (found > 0) Log.Info("rescan queued " + found + " file(s)");
        }

        /// <summary>Emit a file the helper itself put in the folder? Never — that would be an echo.</summary>
        public void FlushPending()
        {
            List<Candidate> all = new List<Candidate>();
            lock (_gate)
            {
                foreach (KeyValuePair<string, Candidate> pair in _pending) all.Add(pair.Value);
                _pending.Clear();
            }
            for (int i = 0; i < all.Count; i++) TryCapture(all[i]);
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
            _running = false;
            lock (_gate) Monitor.PulseAll(_gate);
            if (_watcher != null)
            {
                try
                {
                    _watcher.EnableRaisingEvents = false;
                    _watcher.Dispose();
                }
                catch (Exception ex)
                {
                    Log.Warn("watcher dispose: " + Paths.Describe(ex));
                }
                _watcher = null;
            }
            if (_worker != null) _worker.Join(1000);
        }

        private sealed class Candidate
        {
            public Candidate(string path, DateTime firstSeen)
            {
                Path = path;
                FirstSeen = firstSeen;
                LastChange = firstSeen;
            }

            public string Path { get; private set; }
            public DateTime FirstSeen { get; set; }
            public DateTime LastChange { get; set; }
        }
    }

    internal sealed class FileCapturedEvent : EventArgs
    {
        public FileCapturedEvent(string file, string sha256, int width, int height, long bytes, string name)
        {
            File = file;
            Sha256 = sha256;
            Width = width;
            Height = height;
            Bytes = bytes;
            Name = name;
        }

        public string File { get; private set; }
        public string Sha256 { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }
        public long Bytes { get; private set; }
        public string Name { get; private set; }
    }
}
