// LinkOK helper — image + hash helpers.
//
// Everything that touches pixels lives here so the protocol layer only deals
// with files, hashes and sizes.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace LinkOK.Helper
{
    internal static class Hashing
    {
        public static string Sha256Hex(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return ToHex(sha.ComputeHash(bytes));
            }
        }

        public static string Sha256HexOfFile(string path)
        {
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                       FileShare.ReadWrite | FileShare.Delete))
            using (SHA256 sha = SHA256.Create())
            {
                return ToHex(sha.ComputeHash(fs));
            }
        }

        public static string Sha256HexOfText(string text)
        {
            return Sha256Hex(new UTF8Encoding(false).GetBytes(text ?? string.Empty));
        }

        private static string ToHex(byte[] hash)
        {
            StringBuilder sb = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
            return sb.ToString();
        }
    }

    internal static class ImageFile
    {
        private static readonly string[] PngSignature = { "89", "50", "4e", "47" };

        /// <summary>Encode a bitmap as PNG bytes.</summary>
        public static byte[] EncodePng(Bitmap bitmap)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                bitmap.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }

        /// <summary>
        /// Read width/height straight out of the bytes, falling back to a full
        /// decode. Used for both clipboard spills and watched files.
        /// </summary>
        public static bool TryGetDimensions(byte[] bytes, out int width, out int height)
        {
            width = 0;
            height = 0;
            try
            {
                using (MemoryStream ms = new MemoryStream(bytes, false))
                using (Image image = Image.FromStream(ms, false, false))
                {
                    width = image.Width;
                    height = image.Height;
                    return width > 0 && height > 0;
                }
            }
            catch (ArgumentException)
            {
                return false;
            }
            catch (Exception ex)
            {
                Log.Warn("dimension probe failed: " + Paths.Describe(ex));
                return false;
            }
        }

        public static Bitmap Decode(byte[] bytes)
        {
            using (MemoryStream ms = new MemoryStream(bytes, false))
            using (Image image = Image.FromStream(ms, true, true))
            {
                // Clone onto a fresh 32bpp bitmap so the stream can be disposed.
                Bitmap copy = new Bitmap(image.Width, image.Height, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(copy))
                {
                    g.DrawImage(image, 0, 0, image.Width, image.Height);
                }
                return copy;
            }
        }

        public static Bitmap DecodeFile(string path)
        {
            using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                       FileShare.ReadWrite | FileShare.Delete))
            {
                byte[] bytes = new byte[fs.Length];
                int read = 0;
                while (read < bytes.Length)
                {
                    int n = fs.Read(bytes, read, bytes.Length - read);
                    if (n <= 0) break;
                    read += n;
                }
                if (read != bytes.Length) Array.Resize(ref bytes, read);
                return Decode(bytes);
            }
        }

        /// <summary>Sorting key for "内容是否相同" checks: bytes, not the encoded filename.</summary>
        public static bool IsPng(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 8) return false;
            return bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47
                && bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A;
        }

        public static string SignatureHint(byte[] bytes)
        {
            if (bytes == null) return "null";
            StringBuilder sb = new StringBuilder();
            int count = Math.Min(4, bytes.Length);
            for (int i = 0; i < count; i++) sb.Append(bytes[i].ToString("x2"));
            return "len=" + bytes.Length + " head=" + sb;
        }

        /// <summary>
        /// CF_DIB payload: a BITMAPINFOHEADER followed by bottom-up BGRA rows,
        /// which is what Word / Paint / Chromium expect from "DIB".
        /// </summary>
        public static byte[] BuildDib(Bitmap bitmap)
        {
            Rectangle rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            BitmapData data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = data.Stride;
                byte[] pixels = new byte[stride * bitmap.Height];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);

                int width = bitmap.Width;
                int height = bitmap.Height;
                int rowBytes = width * 4;
                byte[] dib = new byte[40 + rowBytes * height];

                WriteInt32(dib, 0, 40);          // biSize
                WriteInt32(dib, 4, width);       // biWidth
                WriteInt32(dib, 8, height);      // biHeight (>0 → bottom-up)
                WriteInt16(dib, 12, 1);          // biPlanes
                WriteInt16(dib, 14, 32);         // biBitCount
                WriteInt32(dib, 16, 0);          // BI_RGB
                WriteInt32(dib, 20, rowBytes * height); // biSizeImage
                WriteInt32(dib, 24, 2835);       // biXPelsPerMeter (~72 DPI)
                WriteInt32(dib, 28, 2835);
                WriteInt32(dib, 32, 0);
                WriteInt32(dib, 36, 0);

                for (int y = 0; y < height; y++)
                {
                    int srcRow = (height - 1 - y) * stride; // flip to bottom-up
                    Buffer.BlockCopy(pixels, srcRow, dib, 40 + y * rowBytes, rowBytes);
                }
                return dib;
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        private static void WriteInt32(byte[] target, int offset, int value)
        {
            target[offset] = (byte)(value & 0xFF);
            target[offset + 1] = (byte)((value >> 8) & 0xFF);
            target[offset + 2] = (byte)((value >> 16) & 0xFF);
            target[offset + 3] = (byte)((value >> 24) & 0xFF);
        }

        private static void WriteInt16(byte[] target, int offset, short value)
        {
            target[offset] = (byte)(value & 0xFF);
            target[offset + 1] = (byte)((value >> 8) & 0xFF);
        }
    }
}
