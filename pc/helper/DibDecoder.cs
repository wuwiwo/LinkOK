// LinkOK helper — CF_DIB / CF_DIBV5 → Bitmap.
//
// System.Drawing cannot consume a raw DIB (only a .bmp *file*, which has a 14-byte
// BITMAPFILEHEADER in front), and the clipboard gives us the bare DIB. So the header,
// palette and pixel array are parsed here, including the variants that actually show up
// on real clipboards: BITMAPINFOHEADER / V4 / V5, 1/4/8/16/24/32 bpp, BI_RGB and
// BI_BITFIELDS masks, bottom-up and top-down rows.
//
// The row conversion is written with Marshal.Copy instead of pointer arithmetic: the build
// uses the in-box csc with the stock reference set, and /unsafe is not one of them.

using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LinkOK.Helper
{
    internal static class DibDecoder
    {
        private const int BI_RGB = 0;
        private const int BI_BITFIELDS = 3;
        private const int BI_ALPHABITFIELDS = 6;
        private const int BI_JPEG = 4;
        private const int BI_PNG = 5;

        private const int MaxDimension = 20000;

        public static Bitmap Decode(byte[] dib)
        {
            if (dib == null) throw new ArgumentNullException("dib");

            int offset = 0;
            // Some producers hand over a full .bmp file; tolerate it.
            if (dib.Length > 14 && dib[0] == (byte)'B' && dib[1] == (byte)'M')
            {
                offset = BitConverter.ToInt32(dib, 10);
                if (offset <= 0 || offset >= dib.Length) offset = 14;
            }

            if (dib.Length - offset < 12) throw new InvalidOperationException("DIB header truncated");

            int headerSize = BitConverter.ToInt32(dib, offset);
            int width, height, bitCount, compression, clrUsed;
            int headerEnd;
            bool coreHeader = headerSize == 12;

            if (coreHeader)
            {
                // BITMAPCOREHEADER: WORD w, WORD h, WORD planes, WORD bits.
                width = BitConverter.ToInt16(dib, offset + 4);
                height = BitConverter.ToInt16(dib, offset + 6);
                bitCount = BitConverter.ToInt16(dib, offset + 10);
                compression = BI_RGB;
                clrUsed = 0;
                headerEnd = offset + 12;
            }
            else
            {
                if (headerSize < 40 || offset + 40 > dib.Length)
                {
                    throw new InvalidOperationException("unsupported DIB header size " + headerSize);
                }
                width = BitConverter.ToInt32(dib, offset + 4);
                height = BitConverter.ToInt32(dib, offset + 8);
                bitCount = BitConverter.ToInt16(dib, offset + 14);
                compression = BitConverter.ToInt32(dib, offset + 16);
                clrUsed = BitConverter.ToInt32(dib, offset + 32);
                headerEnd = offset + headerSize;
            }

            if (compression == BI_JPEG || compression == BI_PNG)
            {
                // Rare, but legal: the payload after the header is a whole image.
                int start = headerEnd;
                if (dib.Length - start < 16) throw new InvalidOperationException("embedded image truncated");
                using (System.IO.MemoryStream ms =
                    new System.IO.MemoryStream(dib, start, dib.Length - start, false))
                using (Image embedded = Image.FromStream(ms, true, true))
                {
                    return CloneToArgb(embedded);
                }
            }

            bool topDown = height < 0;
            height = Math.Abs(height);
            if (width <= 0 || height <= 0 || width > MaxDimension || height > MaxDimension)
            {
                throw new InvalidOperationException(
                    string.Format("implausible DIB size {0}x{1}", width, height));
            }
            if (bitCount != 1 && bitCount != 4 && bitCount != 8
                && bitCount != 16 && bitCount != 24 && bitCount != 32)
            {
                throw new InvalidOperationException("unsupported DIB bit count " + bitCount);
            }

            // Colour masks for BI_BITFIELDS.
            uint maskR = 0, maskG = 0, maskB = 0, maskA = 0;
            int paletteOffset = headerEnd;
            if (!coreHeader && (compression == BI_BITFIELDS || compression == BI_ALPHABITFIELDS))
            {
                int maskStart = (headerSize >= 108) ? offset + 40 : headerEnd;
                if (maskStart + 12 > dib.Length) throw new InvalidOperationException("masks truncated");
                maskR = BitConverter.ToUInt32(dib, maskStart);
                maskG = BitConverter.ToUInt32(dib, maskStart + 4);
                maskB = BitConverter.ToUInt32(dib, maskStart + 8);
                if (headerSize >= 108 && maskStart + 16 <= dib.Length)
                {
                    maskA = BitConverter.ToUInt32(dib, maskStart + 12);
                }
                if (headerSize < 108) paletteOffset = headerEnd + 12;
                if (compression == BI_ALPHABITFIELDS && headerSize < 108) paletteOffset += 4;
            }
            else if (bitCount == 16)
            {
                // Undocumented-but-universal BI_RGB 16bpp convention is RGB555.
                maskR = 0x7C00; maskG = 0x03E0; maskB = 0x001F;
            }

            // Palette for ≤ 8bpp.
            Color[] palette = null;
            if (bitCount <= 8)
            {
                int entrySize = coreHeader ? 3 : 4;
                int count = clrUsed > 0 ? clrUsed : (1 << bitCount);
                if (count > 256) count = 256;
                int available = (dib.Length - paletteOffset) / entrySize;
                if (available < count) count = Math.Max(0, available);
                palette = new Color[Math.Max(count, 1)];
                for (int i = 0; i < count; i++)
                {
                    int p = paletteOffset + i * entrySize;
                    palette[i] = Color.FromArgb(255, dib[p + 2], dib[p + 1], dib[p]);
                }
                if (count == 0) palette[0] = Color.Black;
                paletteOffset += count * entrySize;
            }

            int stride = ((width * bitCount + 31) / 32) * 4;
            int needed = stride * height;
            if (paletteOffset + needed > dib.Length)
            {
                // Truncated pixel data: decode what is there, leave the rest black.
                int rows = Math.Max(0, Math.Min(height, (dib.Length - paletteOffset) / Math.Max(1, stride)));
                if (rows == 0) throw new InvalidOperationException("DIB pixel data truncated");
                Log.Warn(string.Format("DIB pixel data short: need {0} bytes, have {1} ({2}/{3} rows)",
                    needed, dib.Length - paletteOffset, rows, height));
                height = rows;
            }

            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            try
            {
                BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height),
                    ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] srcRow = new byte[stride];
                    byte[] destRow = new byte[data.Stride];
                    for (int y = 0; y < height; y++)
                    {
                        int srcOffset = paletteOffset + y * stride;
                        Buffer.BlockCopy(dib, srcOffset, srcRow, 0, stride);

                        // Bitmap rows are top-down in memory; DIBs usually are not.
                        int destRowIndex = topDown ? y : height - 1 - y;
                        ConvertRow(srcRow, destRow, width, bitCount, palette, maskR, maskG, maskB, maskA);
                        Marshal.Copy(destRow, 0, (IntPtr)((long)data.Scan0 + destRowIndex * data.Stride),
                            data.Stride);
                    }
                }
                finally
                {
                    bitmap.UnlockBits(data);
                }
                return bitmap;
            }
            catch
            {
                bitmap.Dispose();
                throw;
            }
        }

        /// <summary>One DIB scanline (bottom-up in the buffer) → one 32bpp BGRA scanline.</summary>
        private static void ConvertRow(byte[] src, byte[] dest, int width, int bitCount,
            Color[] palette, uint maskR, uint maskG, uint maskB, uint maskA)
        {
            for (int x = 0; x < width; x++) dest[x * 4 + 3] = 255;

            switch (bitCount)
            {
                case 32:
                    {
                        bool hasMasks = (maskR | maskG | maskB) != 0;
                        for (int x = 0; x < width; x++)
                        {
                            int o = x * 4;
                            byte r = src[o + 2];
                            byte g = src[o + 1];
                            byte b = src[o + 0];
                            byte a = 255;
                            if (hasMasks)
                            {
                                uint value = (uint)(src[o] | (src[o + 1] << 8)
                                                    | (src[o + 2] << 16) | (src[o + 3] << 24));
                                b = ExpandMask(value, maskB);
                                g = ExpandMask(value, maskG);
                                r = ExpandMask(value, maskR);
                                if (maskA != 0) a = ExpandMask(value, maskA);
                            }
                            else
                            {
                                // BI_RGB 32bpp: the alpha byte is documented as unused and many
                                // apps leave zero there. Zero means opaque, or the paste is invisible.
                                byte rawAlpha = src[o + 3];
                                a = rawAlpha == 0 ? (byte)255 : rawAlpha;
                            }
                            dest[o + 0] = b;
                            dest[o + 1] = g;
                            dest[o + 2] = r;
                            dest[o + 3] = a;
                        }
                        break;
                    }
                case 24:
                    for (int x = 0; x < width; x++)
                    {
                        int s = x * 3;
                        int d = x * 4;
                        dest[d + 0] = src[s + 0];
                        dest[d + 1] = src[s + 1];
                        dest[d + 2] = src[s + 2];
                    }
                    break;
                case 16:
                    for (int x = 0; x < width; x++)
                    {
                        int s = x * 2;
                        uint value = (uint)(src[s] | (src[s + 1] << 8));
                        int d = x * 4;
                        dest[d + 0] = ExpandMask(value, maskB);
                        dest[d + 1] = ExpandMask(value, maskG);
                        dest[d + 2] = ExpandMask(value, maskR);
                        if (maskA != 0) dest[d + 3] = ExpandMask(value, maskA);
                    }
                    break;
                case 8:
                    for (int x = 0; x < width; x++)
                    {
                        Color c = palette == null ? Color.Black : Index(palette, src[x]);
                        int d = x * 4;
                        dest[d + 0] = c.B;
                        dest[d + 1] = c.G;
                        dest[d + 2] = c.R;
                    }
                    break;
                case 4:
                    for (int x = 0; x < width; x++)
                    {
                        byte packed = src[x >> 1];
                        int index = (x & 1) == 0 ? (packed >> 4) : (packed & 0x0F);
                        Color c = palette == null ? Color.Black : Index(palette, index);
                        int d = x * 4;
                        dest[d + 0] = c.B;
                        dest[d + 1] = c.G;
                        dest[d + 2] = c.R;
                    }
                    break;
                case 1:
                    for (int x = 0; x < width; x++)
                    {
                        int index = (src[x >> 3] >> (7 - (x & 7))) & 1;
                        Color c = palette == null
                            ? (index == 0 ? Color.Black : Color.White)
                            : Index(palette, index);
                        int d = x * 4;
                        dest[d + 0] = c.B;
                        dest[d + 1] = c.G;
                        dest[d + 2] = c.R;
                    }
                    break;
            }
        }

        private static Color Index(Color[] palette, int index)
        {
            if (index >= 0 && index < palette.Length) return palette[index];
            return Color.Black;
        }

        /// <summary>Pull one channel out of a masked pixel value and scale it to 0..255.</summary>
        private static byte ExpandMask(uint value, uint mask)
        {
            if (mask == 0) return 255;
            int shift = 0;
            while (shift < 32 && ((mask >> shift) & 1) == 0) shift++;
            if (shift >= 32) return 0;
            uint shifted = (value & mask) >> shift;
            uint normalizedMask = mask >> shift;
            int bits = 0;
            while (bits < 32 && ((normalizedMask >> bits) & 1) == 1) bits++;
            if (bits == 0) return 0;
            if (bits >= 8) return (byte)(shifted >> (bits - 8));
            uint max = (1u << bits) - 1;
            return (byte)((shifted * 255 + max / 2) / max);
        }

        private static Bitmap CloneToArgb(Image image)
        {
            Bitmap copy = new Bitmap(image.Width, image.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(copy))
            {
                g.DrawImage(image, 0, 0, image.Width, image.Height);
            }
            return copy;
        }
    }
}
