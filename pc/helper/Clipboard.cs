// LinkOK helper — Win32 clipboard access with contention handling.
//
// SPEC §5.2: the sources of a PC Capture on the clipboard are CF_DIB / CF_BITMAP /
// CF_PNG (CF_DIBV5 is read too). SPEC §5.4: text is capped at 64 KB.
//
// Every read is retried, because the clipboard is a single global lock and any
// foreground app may be holding it. After a bounded number of attempts the caller
// gets a ClipboardBusyException and emits an error event instead of hanging.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace LinkOK.Helper
{
    /// <summary>Raised when another application kept the clipboard locked.</summary>
    [Serializable]
    internal sealed class ClipboardBusyException : Exception
    {
        public ClipboardBusyException(string message) : base(message) { }
    }

    internal enum ClipboardImageSource
    {
        None = 0,
        Png,
        DibV5,
        Dib,
        Bitmap
    }

    internal sealed class ClipboardReadResult
    {
        public string Text;
        public byte[] ImagePng;          // encoded PNG of the clipboard image, null when absent
        public ClipboardImageSource Source;
        public int Width;
        public int Height;

        public bool HasText
        {
            get { return Text != null; }
        }

        public bool HasImage
        {
            get { return ImagePng != null; }
        }

        public bool IsEmpty
        {
            get { return !HasText && !HasImage; }
        }
    }

    internal static class Clipboard
    {
        /// <summary>SPEC §5.4 / D4: clipboard text is capped at 64 KB.</summary>
        public const int MaxTextBytes = 64 * 1024;

        private const int MaxAttempts = 10;
        private const int RetryDelayMs = 40;

        [DllImport("gdi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteObject(IntPtr hObject);

        /// <summary>
        /// Run <paramref name="action"/> with the clipboard held, retrying when another app
        /// owns it. The owner window is our own message-only window so marshalling stays
        /// in-process.
        /// </summary>
        public static T WithOpen<T>(IntPtr owner, string purpose, Func<T> action)
        {
            Exception last = null;
            for (int attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                if (!NativeMethods.OpenClipboard(owner))
                {
                    int err = Marshal.GetLastWin32Error();
                    last = new ClipboardBusyException(
                        string.Format("OpenClipboard({0}) failed, win32={1}", purpose, err));
                    System.Threading.Thread.Sleep(RetryDelayMs);
                    continue;
                }
                try
                {
                    return action();
                }
                finally
                {
                    NativeMethods.CloseClipboard();
                }
            }
            int lastError = last == null ? 0 : Marshal.GetLastWin32Error();
            Log.Warn("clipboard busy after " + MaxAttempts + " attempts, last win32=" + lastError);
            throw last as ClipboardBusyException
                  ?? new ClipboardBusyException("clipboard busy: " + purpose);
        }

        /// <summary>Read whatever a clipboard update produced: text, an image, or both.</summary>
        public static ClipboardReadResult Read(IntPtr owner)
        {
            return WithOpen(owner, "read", delegate
            {
                ClipboardReadResult result = new ClipboardReadResult();

                // Images first: a copied image often also carries a file name as text.
                uint pngFormat = NativeMethods.PngFormatId();
                if (pngFormat != 0 && NativeMethods.IsClipboardFormatAvailable(pngFormat))
                {
                    byte[] png = ReadBytes(pngFormat);
                    if (png != null && png.Length > 0)
                    {
                        if (ImageFile.IsPng(png))
                        {
                            result.ImagePng = png;
                            result.Source = ClipboardImageSource.Png;
                        }
                        else
                        {
                            Log.Warn("PNG clipboard format held non-PNG bytes; "
                                     + ImageFile.SignatureHint(png));
                        }
                    }
                }

                if (result.ImagePng == null && NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_DIBV5))
                {
                    byte[] dib = ReadBytes(NativeMethods.CF_DIBV5);
                    result.ImagePng = TryDibToPng(dib, ClipboardImageSource.DibV5, result);
                }

                if (result.ImagePng == null && NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_DIB))
                {
                    byte[] dib = ReadBytes(NativeMethods.CF_DIB);
                    result.ImagePng = TryDibToPng(dib, ClipboardImageSource.Dib, result);
                }

                if (result.ImagePng == null && NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_BITMAP))
                {
                    result.ImagePng = TryBitmapToPng(result);
                }

                if (result.ImagePng != null)
                {
                    int w, h;
                    if (ImageFile.TryGetDimensions(result.ImagePng, out w, out h))
                    {
                        result.Width = w;
                        result.Height = h;
                    }
                }

                if (NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_UNICODETEXT))
                {
                    bool truncated;
                    result.Text = ReadText(out truncated);
                }
                else if (NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_TEXT))
                {
                    bool truncated;
                    result.Text = ReadAnsiText(out truncated);
                }

                return result;
            });
        }

        /// <summary>Read clipboard text only (used for echo comparison).</summary>
        public static string ReadTextOnly(IntPtr owner)
        {
            return WithOpen(owner, "read-text", delegate
            {
                bool truncated;
                if (NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_UNICODETEXT))
                {
                    return ReadText(out truncated);
                }
                if (NativeMethods.IsClipboardFormatAvailable(NativeMethods.CF_TEXT))
                {
                    return ReadAnsiText(out truncated);
                }
                return null;
            });
        }

        private static string ReadText(out bool truncated)
        {
            string result = null;
            bool wasTruncated = false;
            IntPtr handle = NativeMethods.GetClipboardData(NativeMethods.CF_UNICODETEXT);
            if (handle != IntPtr.Zero)
            {
                IntPtr ptr = NativeMethods.GlobalLock(handle);
                if (ptr != IntPtr.Zero)
                {
                    try
                    {
                        string text = Marshal.PtrToStringUni(ptr);
                        if (text != null) result = CapText(text, out wasTruncated);
                    }
                    finally
                    {
                        NativeMethods.GlobalUnlock(handle);
                    }
                }
            }
            truncated = wasTruncated;
            return result;
        }

        private static string ReadAnsiText(out bool truncated)
        {
            string result = null;
            bool wasTruncated = false;
            IntPtr handle = NativeMethods.GetClipboardData(NativeMethods.CF_TEXT);
            if (handle != IntPtr.Zero)
            {
                IntPtr ptr = NativeMethods.GlobalLock(handle);
                if (ptr != IntPtr.Zero)
                {
                    try
                    {
                        string text = Marshal.PtrToStringAnsi(ptr);
                        if (text != null) result = CapText(text, out wasTruncated);
                    }
                    finally
                    {
                        NativeMethods.GlobalUnlock(handle);
                    }
                }
            }
            truncated = wasTruncated;
            return result;
        }

        /// <summary>
        /// SPEC §5.4: cap at 64 KB, truncating rather than rejecting. Truncation happens on a
        /// char boundary so the result is always valid UTF-16 and re-encodes cleanly.
        /// </summary>
        public static string CapText(string text, out bool truncated)
        {
            truncated = false;
            if (text == null) return null;
            UTF8Encoding utf8 = new UTF8Encoding(false);
            int byteCount = utf8.GetByteCount(text);
            if (byteCount <= MaxTextBytes) return text;

            // Estimate, then walk down until the encoded form fits. The loop is bounded and
            // shortening only, so it terminates on the first char that fits.
            int chars = (int)((long)text.Length * MaxTextBytes / Math.Max(1, byteCount));
            if (chars >= text.Length) chars = text.Length - 1;
            if (chars < 0) chars = 0;
            while (chars > 0 && utf8.GetByteCount(text.Substring(0, chars)) > MaxTextBytes) chars--;
            // Never split a surrogate pair.
            if (chars > 0 && char.IsHighSurrogate(text[chars - 1])) chars--;
            truncated = true;
            return chars <= 0 ? string.Empty : text.Substring(0, chars);
        }

        private static byte[] ReadBytes(uint format)
        {
            IntPtr handle = NativeMethods.GetClipboardData(format);
            if (handle == IntPtr.Zero) return null;
            UIntPtr sizePtr = NativeMethods.GlobalSize(handle);
            long size = (long)sizePtr.ToUInt64();
            if (size <= 0) return null;
            IntPtr ptr = NativeMethods.GlobalLock(handle);
            if (ptr == IntPtr.Zero) return null;
            try
            {
                byte[] buffer = new byte[size];
                Marshal.Copy(ptr, buffer, 0, buffer.Length);
                return buffer;
            }
            finally
            {
                NativeMethods.GlobalUnlock(handle);
            }
        }

        private static byte[] TryDibToPng(byte[] dib, ClipboardImageSource source, ClipboardReadResult into)
        {
            if (dib == null || dib.Length < 40)
            {
                Log.Warn("DIB too small: " + ImageFile.SignatureHint(dib));
                return null;
            }
            try
            {
                using (System.Drawing.Bitmap bitmap = DibDecoder.Decode(dib))
                {
                    byte[] png = ImageFile.EncodePng(bitmap);
                    into.Source = source;
                    into.Width = bitmap.Width;
                    into.Height = bitmap.Height;
                    return png;
                }
            }
            catch (Exception ex)
            {
                Log.Warn("DIB decode failed (" + source + "): " + Paths.Describe(ex));
                return null;
            }
        }

        private static byte[] TryBitmapToPng(ClipboardReadResult into)
        {
            IntPtr handle = NativeMethods.GetClipboardData(NativeMethods.CF_BITMAP);
            if (handle == IntPtr.Zero)
            {
                Log.Warn("CF_BITMAP advertised but GetClipboardData returned NULL");
                return null;
            }
            try
            {
                using (System.Drawing.Image image = System.Drawing.Image.FromHbitmap(handle))
                using (System.Drawing.Bitmap copy = new System.Drawing.Bitmap(
                           image.Width, image.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(copy))
                    {
                        g.DrawImage(image, 0, 0, image.Width, image.Height);
                    }
                    into.Source = ClipboardImageSource.Bitmap;
                    into.Width = copy.Width;
                    into.Height = copy.Height;
                    return ImageFile.EncodePng(copy);
                }
            }
            catch (Exception ex)
            {
                Log.Warn("CF_BITMAP conversion failed: " + Paths.Describe(ex));
                return null;
            }
        }

        // ── Writing ──────────────────────────────────────────────────────────

        /// <summary>
        /// Put PNG bytes on the clipboard as CF_DIB + CF_BITMAP (+ PNG when it decodes), so
        /// Paint/Word/browsers can paste it. Returns false if the clipboard stayed locked.
        /// </summary>
        public static bool WriteImage(IntPtr owner, byte[] pngBytes, out string error)
        {
            string localError = null;
            System.Drawing.Bitmap bitmap = null;
            try
            {
                bitmap = ImageFile.Decode(pngBytes);
            }
            catch (Exception ex)
            {
                error = "decode: " + Paths.Describe(ex);
                return false;
            }

            try
            {
                byte[] dib = ImageFile.BuildDib(bitmap);
                bool ok = WithOpen(owner, "write-image", delegate
                {
                    if (!NativeMethods.EmptyClipboard())
                    {
                        localError = "EmptyClipboard failed, win32=" + Marshal.GetLastWin32Error();
                        return false;
                    }
                    if (!SetBytes(NativeMethods.CF_DIB, dib))
                    {
                        localError = "SetClipboardData(CF_DIB) failed, win32="
                                      + Marshal.GetLastWin32Error();
                        return false;
                    }

                    // CF_BITMAP needs an HBITMAP. The system copies it into the clipboard, so
                    // the local handle is deleted afterwards; on success ownership has moved.
                    IntPtr hbitmap = bitmap.GetHbitmap();
                    try
                    {
                        if (NativeMethods.SetClipboardData(NativeMethods.CF_BITMAP, hbitmap) == IntPtr.Zero)
                        {
                            Log.Warn("SetClipboardData(CF_BITMAP) failed, win32="
                                     + Marshal.GetLastWin32Error());
                        }
                        else
                        {
                            hbitmap = IntPtr.Zero;
                        }
                    }
                    finally
                    {
                        if (hbitmap != IntPtr.Zero) DeleteObject(hbitmap);
                    }

                    uint pngFormat = NativeMethods.PngFormatId();
                    if (pngFormat != 0 && !SetBytes(pngFormat, pngBytes))
                    {
                        // Non-fatal: the DIB alone is pasteable everywhere that matters.
                        Log.Warn("SetClipboardData(PNG) failed, win32="
                                 + Marshal.GetLastWin32Error());
                    }
                    return true;
                });
                error = localError;
                return ok;
            }
            catch (ClipboardBusyException ex)
            {
                error = "clipboard busy: " + ex.Message;
                return false;
            }
            finally
            {
                if (bitmap != null) bitmap.Dispose();
            }
        }

        /// <summary>Put text on the clipboard as CF_UNICODETEXT.</summary>
        public static bool WriteText(IntPtr owner, string text, out string error)
        {
            string localError = null;
            byte[] payload = Encoding.Unicode.GetBytes((text ?? string.Empty) + "\0");
            try
            {
                bool ok = WithOpen(owner, "write-text", delegate
                {
                    if (!NativeMethods.EmptyClipboard())
                    {
                        localError = "EmptyClipboard failed, win32=" + Marshal.GetLastWin32Error();
                        return false;
                    }
                    if (!SetBytes(NativeMethods.CF_UNICODETEXT, payload))
                    {
                        localError = "SetClipboardData(CF_UNICODETEXT) failed, win32="
                                     + Marshal.GetLastWin32Error();
                        return false;
                    }
                    return true;
                });
                error = localError;
                return ok;
            }
            catch (ClipboardBusyException ex)
            {
                error = "clipboard busy: " + ex.Message;
                return false;
            }
        }

        /// <summary>Ownership of a successfully set HGLOBAL moves to the clipboard.</summary>
        private static bool SetBytes(uint format, byte[] bytes)
        {
            IntPtr mem = NativeMethods.GlobalAlloc(
                NativeMethods.GMEM_MOVEABLE | NativeMethods.GMEM_ZEROINIT, (UIntPtr)(uint)bytes.Length);
            if (mem == IntPtr.Zero) return false;
            IntPtr ptr = NativeMethods.GlobalLock(mem);
            if (ptr == IntPtr.Zero)
            {
                NativeMethods.GlobalFree(mem);
                return false;
            }
            try
            {
                Marshal.Copy(bytes, 0, ptr, bytes.Length);
            }
            finally
            {
                NativeMethods.GlobalUnlock(mem);
            }
            if (NativeMethods.SetClipboardData(format, mem) == IntPtr.Zero)
            {
                NativeMethods.GlobalFree(mem);
                return false;
            }
            return true;
        }

        /// <summary>List the formats currently on the clipboard, for diagnostics.</summary>
        public static string DescribeFormats(IntPtr owner)
        {
            try
            {
                return WithOpen(owner, "enum", delegate
                {
                    List<string> names = new List<string>();
                    uint format = 0;
                    while ((format = NativeMethods.EnumClipboardFormats(format)) != 0)
                    {
                        names.Add(format.ToString(CultureInfo.InvariantCulture));
                        if (names.Count > 256) break;
                    }
                    return string.Join(",", names.ToArray());
                });
            }
            catch (ClipboardBusyException ex)
            {
                return "busy: " + ex.Message;
            }
        }
    }
}
