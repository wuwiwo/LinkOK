// LinkOK helper — a self-contained QR Code Model 2 encoder (byte mode).
//
// SPEC Q2 decided to use a library for QR, but the C# helper cannot: there is no package
// manager for .NET Framework 4.8 on this machine and adding a NuGet binary is out of scope.
// The payload is tiny and ASCII ("linkok://pair?host=…&port=…&code=…&fp=…", ~90 bytes), so
// a compact encoder is written here: versions 1–10, error correction level M, all eight
// masks, standard penalty scoring. Output is a bool matrix; drawing lives in QrWindow.cs.
//
// This is ISO/IEC 18004 Model 2. Nothing here is LinkOK-specific.

using System;
using System.Collections.Generic;
using System.Text;

namespace LinkOK.Helper
{
    internal sealed class QrCode
    {
        /// <summary>Byte mode, EC level M is what a phone camera handles comfortably.</summary>
        private const int EccLevelM = 0;

        private const int MinVersion = 1;
        private const int MaxVersion = 10;

        /// <summary>EC codewords per block, level M, versions 1–10 (ISO/IEC 18004 table 13/17).</summary>
        private static readonly int[] EccCodewordsPerBlockM = { 10, 16, 26, 18, 24, 16, 18, 22, 22, 26 };

        /// <summary>Error-correction block count, level M, versions 1–10.</summary>
        private static readonly int[] BlockCountM = { 1, 1, 1, 2, 2, 4, 4, 4, 5, 5 };

        private readonly int _version;
        private readonly int _size;
        private readonly bool[,] _modules;
        private readonly bool[,] _isFunction;

        public int Version
        {
            get { return _version; }
        }

        public int Size
        {
            get { return _size; }
        }

        /// <summary>true = dark. Indexed [y, x].</summary>
        public bool this[int x, int y]
        {
            get { return _modules[y, x]; }
        }

        private QrCode(int version)
        {
            _version = version;
            _size = version * 4 + 17;
            _modules = new bool[_size, _size];
            _isFunction = new bool[_size, _size];
        }

        /// <summary>Longest payload the encoder accepts, in bytes at EC level M.</summary>
        public static int MaxPayloadBytes
        {
            get
            {
                int version = MaxVersion;
                int dataCodewords = RawCodewords(version) - EccCodewordsPerBlockM[version - 1] * BlockCountM[version - 1];
                return dataCodewords - 2 - (version >= 10 ? 2 : 1); // mode + count + terminator
            }
        }

        /// <summary>
        /// Encode UTF-8 bytes. Throws <see cref="ArgumentException"/> when the payload does not
        /// fit version 10 at EC level M — the caller shows the payload as text instead.
        /// </summary>
        public static QrCode Encode(byte[] payload)
        {
            if (payload == null) throw new ArgumentNullException("payload");
            int version = ChooseVersion(payload.Length);
            if (version < MinVersion || version > MaxVersion) return null;

            QrCode qr = new QrCode(version);
            bool[,] matrix = qr.BuildMatrix(payload);
            if (matrix == null) return null;
            return qr;
        }

        public static QrCode EncodeText(string text)
        {
            return Encode(new UTF8Encoding(false).GetBytes(text ?? string.Empty));
        }

        private static int ChooseVersion(int byteLength)
        {
            for (int version = MinVersion; version <= MaxVersion; version++)
            {
                int dataCodewords = RawCodewords(version)
                                    - EccCodewordsPerBlockM[version - 1] * BlockCountM[version - 1];
                int countBits = version >= 10 ? 16 : 8;
                int neededBits = 4 + countBits + byteLength * 8;
                if (neededBits <= dataCodewords * 8) return version;
            }
            return MaxVersion + 1;
        }

        private bool[,] BuildMatrix(byte[] payload)
        {
            List<bool> dataBits = BuildDataBits(payload);
            if (dataBits == null) return null;

            byte[] dataCodewords = new byte[dataBits.Count / 8];
            for (int i = 0; i < dataBits.Count; i++)
            {
                if (dataBits[i]) dataCodewords[i >> 3] |= (byte)(0x80 >> (i & 7));
            }

            byte[] allCodewords = AddErrorCorrectionAndInterleave(dataCodewords);

            DrawFunctionPatterns();
            PlaceCodewords(allCodewords);

            // Pick the mask with the lowest penalty; both format bits copies are redrawn each try.
            int bestMask = 0;
            int bestPenalty = int.MaxValue;
            for (int mask = 0; mask < 8; mask++)
            {
                ApplyMask(mask);
                DrawFormatBits(mask);
                int penalty = ComputePenalty();
                if (penalty < bestPenalty)
                {
                    bestPenalty = penalty;
                    bestMask = mask;
                }
                ApplyMask(mask); // XOR again to undo
            }
            ApplyMask(bestMask);
            DrawFormatBits(bestMask);
            return _modules;
        }

        private List<bool> BuildDataBits(byte[] payload)
        {
            int dataCodewords = RawCodewords(_version)
                                - EccCodewordsPerBlockM[_version - 1] * BlockCountM[_version - 1];
            int capacityBits = dataCodewords * 8;
            int countBits = _version >= 10 ? 16 : 8;
            int neededBits = 4 + countBits + payload.Length * 8;
            if (neededBits > capacityBits) return null;

            List<bool> bits = new List<bool>(capacityBits);
            AppendBits(bits, 0x4, 4);                       // byte mode indicator 0100
            AppendBits(bits, payload.Length, countBits);    // character count
            for (int i = 0; i < payload.Length; i++) AppendBits(bits, payload[i], 8);

            int terminator = Math.Min(4, capacityBits - bits.Count);
            AppendBits(bits, 0, terminator);
            while (bits.Count % 8 != 0) bits.Add(false);

            for (int pad = 0xEC; bits.Count < capacityBits; pad ^= 0xEC ^ 0x11)
            {
                AppendBits(bits, pad, 8);
            }
            return bits;
        }

        private static void AppendBits(List<bool> bits, int value, int length)
        {
            for (int i = length - 1; i >= 0; i--) bits.Add(((value >> i) & 1) != 0);
        }

        // ── Reed–Solomon over GF(256), primitive polynomial 0x11D ──────────────

        private byte[] AddErrorCorrectionAndInterleave(byte[] data)
        {
            int rawCodewords = RawCodewords(_version);
            int blockEccLength = EccCodewordsPerBlockM[_version - 1];
            int blockCount = BlockCountM[_version - 1];
            int numShortBlocks = blockCount - rawCodewords % blockCount;
            int shortBlockLength = rawCodewords / blockCount;

            byte[] divisor = ReedSolomonDivisor(blockEccLength);

            byte[][] blocks = new byte[blockCount][];
            int offset = 0;
            for (int i = 0; i < blockCount; i++)
            {
                int dataLength = shortBlockLength - blockEccLength + (i < numShortBlocks ? 0 : 1);
                byte[] blockData = new byte[dataLength];
                Array.Copy(data, offset, blockData, 0, dataLength);
                offset += dataLength;

                byte[] ecc = ReedSolomonRemainder(blockData, divisor);
                // One spare byte at the end for short blocks; skipped during interleaving.
                byte[] block = new byte[shortBlockLength + 1];
                Array.Copy(blockData, block, dataLength);
                Array.Copy(ecc, 0, block, block.Length - blockEccLength, ecc.Length);
                blocks[i] = block;
            }

            byte[] result = new byte[rawCodewords];
            int k = 0;
            for (int i = 0; i < blocks[0].Length; i++)
            {
                for (int j = 0; j < blockCount; j++)
                {
                    if (i == shortBlockLength - blockEccLength && j < numShortBlocks) continue;
                    result[k++] = blocks[j][i];
                }
            }
            return result;
        }

        private static byte[] ReedSolomonDivisor(int degree)
        {
            byte[] result = new byte[degree];
            result[degree - 1] = 1;
            byte root = 1;
            for (int i = 0; i < degree; i++)
            {
                for (int j = 0; j < degree; j++)
                {
                    result[j] = (byte)GfMultiply(result[j], root);
                    if (j + 1 < degree) result[j] ^= result[j + 1];
                }
                root = (byte)GfMultiply(root, 0x02);
            }
            return result;
        }

        private static byte[] ReedSolomonRemainder(byte[] data, byte[] divisor)
        {
            byte[] result = new byte[divisor.Length];
            for (int i = 0; i < data.Length; i++)
            {
                int factor = (data[i] ^ result[0]) & 0xFF;
                Array.Copy(result, 1, result, 0, result.Length - 1);
                result[result.Length - 1] = 0;
                for (int j = 0; j < result.Length; j++)
                {
                    result[j] ^= (byte)GfMultiply(divisor[j], factor);
                }
            }
            return result;
        }

        private static int GfMultiply(int x, int y)
        {
            int z = 0;
            for (int i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return z & 0xFF;
        }

        // ── Module placement ──────────────────────────────────────────────────

        private void DrawFunctionPatterns()
        {
            for (int i = 0; i < _size; i++)
            {
                SetFunction(6, i, i % 2 == 0);
                SetFunction(i, 6, i % 2 == 0);
            }

            DrawFinder(3, 3);
            DrawFinder(_size - 4, 3);
            DrawFinder(3, _size - 4);

            int[] align = AlignmentPositions();
            int last = align.Length - 1;
            for (int i = 0; i < align.Length; i++)
            {
                for (int j = 0; j < align.Length; j++)
                {
                    // The three finder corners have no alignment pattern.
                    if ((i == 0 && j == 0) || (i == 0 && j == last) || (i == last && j == 0)) continue;
                    DrawAlignment(align[i], align[j]);
                }
            }

            DrawFormatBits(0); // reserve the area; the real bits are drawn after masking
            DrawVersionBits();
        }

        private void DrawFinder(int centerX, int centerY)
        {
            for (int dy = -4; dy <= 4; dy++)
            {
                for (int dx = -4; dx <= 4; dx++)
                {
                    int x = centerX + dx;
                    int y = centerY + dy;
                    if (x < 0 || y < 0 || x >= _size || y >= _size) continue;
                    int distance = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    SetFunction(x, y, distance != 2 && distance != 4);
                }
            }
        }

        private void DrawAlignment(int centerX, int centerY)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    SetFunction(centerX + dx, centerY + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
                }
            }
        }

        private int[] AlignmentPositions()
        {
            if (_version == 1) return new int[0];
            int numAlign = _version / 7 + 2;
            int step = (_version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2) * 2;
            int[] result = new int[numAlign];
            result[0] = 6;
            for (int i = numAlign - 1, pos = _size - 7; i >= 1; i--, pos -= step) result[i] = pos;
            return result;
        }

        private void DrawFormatBits(int mask)
        {
            // 2-bit EC level (M = 00) + 3-bit mask, BCH(15,5) protected, XOR 0x5412.
            int data = (EccLevelM << 3) | mask;
            int remainder = data;
            for (int i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >> 9) * 0x537);
            int bits = ((data << 10) | remainder) ^ 0x5412;

            for (int i = 0; i <= 5; i++) SetFunction(8, i, Bit(bits, i));
            SetFunction(8, 7, Bit(bits, 6));
            SetFunction(8, 8, Bit(bits, 7));
            SetFunction(7, 8, Bit(bits, 8));
            for (int i = 9; i < 15; i++) SetFunction(14 - i, 8, Bit(bits, i));

            for (int i = 0; i < 8; i++) SetFunction(_size - 1 - i, 8, Bit(bits, i));
            for (int i = 8; i < 15; i++) SetFunction(8, _size - 15 + i, Bit(bits, i));
            SetFunction(8, _size - 8, true); // always dark
        }

        private void DrawVersionBits()
        {
            if (_version < 7) return;
            int remainder = _version;
            for (int i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1F25);
            int bits = (_version << 12) | remainder;

            for (int i = 0; i < 18; i++)
            {
                bool bit = Bit(bits, i);
                int a = _size - 11 + i % 3;
                int b = i / 3;
                SetFunction(a, b, bit);
                SetFunction(b, a, bit);
            }
        }

        private static bool Bit(int value, int index)
        {
            return ((value >> index) & 1) != 0;
        }

        private void PlaceCodewords(byte[] codewords)
        {
            int bitIndex = 0;
            int totalBits = codewords.Length * 8;
            int direction = -1;
            int row = _size - 1;
            for (int column = _size - 1; column > 0; column -= 2)
            {
                if (column == 6) column--; // vertical timing pattern
                while (true)
                {
                    for (int c = 0; c < 2; c++)
                    {
                        int x = column - c;
                        if (_isFunction[row, x]) continue;
                        bool dark = false;
                        if (bitIndex < totalBits)
                        {
                            dark = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) != 0;
                            bitIndex++;
                        }
                        _modules[row, x] = dark;
                    }
                    row += direction;
                    if (row < 0 || row >= _size)
                    {
                        row -= direction;
                        direction = -direction;
                        break;
                    }
                }
            }
        }

        private void ApplyMask(int mask)
        {
            for (int y = 0; y < _size; y++)
            {
                for (int x = 0; x < _size; x++)
                {
                    if (_isFunction[y, x]) continue;
                    if (MaskBit(mask, x, y)) _modules[y, x] = !_modules[y, x];
                }
            }
        }

        private static bool MaskBit(int mask, int x, int y)
        {
            switch (mask)
            {
                case 0: return (x + y) % 2 == 0;
                case 1: return y % 2 == 0;
                case 2: return x % 3 == 0;
                case 3: return (x + y) % 3 == 0;
                case 4: return (x / 3 + y / 2) % 2 == 0;
                case 5: return x * y % 2 + x * y % 3 == 0;
                case 6: return (x * y % 2 + x * y % 3) % 2 == 0;
                case 7: return ((x + y) % 2 + x * y % 3) % 2 == 0;
                default: throw new ArgumentOutOfRangeException("mask");
            }
        }

        private void SetFunction(int x, int y, bool dark)
        {
            _modules[y, x] = dark;
            _isFunction[y, x] = true;
        }

        /// <summary>ISO/IEC 18004 §7.8.3 penalty rules N1–N4, used to choose the mask.</summary>
        private int ComputePenalty()
        {
            int result = 0;

            for (int y = 0; y < _size; y++)
            {
                bool runColor = false;
                int runLength = 0;
                int[] runHistory = new int[7];
                for (int x = 0; x < _size; x++)
                {
                    bool color = _modules[y, x];
                    if (color == runColor)
                    {
                        runLength++;
                        if (runLength == 5) result += 3;
                        else if (runLength > 5) result++;
                    }
                    else
                    {
                        AddRunToHistory(runLength, runHistory);
                        if (!runColor) result += CountPatterns(runHistory) * 40;
                        runColor = color;
                        runLength = 1;
                    }
                }
                result += TerminateRun(runLength, runColor, runHistory) * 40;
            }

            for (int x = 0; x < _size; x++)
            {
                bool runColor = false;
                int runLength = 0;
                int[] runHistory = new int[7];
                for (int y = 0; y < _size; y++)
                {
                    bool color = _modules[y, x];
                    if (color == runColor)
                    {
                        runLength++;
                        if (runLength == 5) result += 3;
                        else if (runLength > 5) result++;
                    }
                    else
                    {
                        AddRunToHistory(runLength, runHistory);
                        if (!runColor) result += CountPatterns(runHistory) * 40;
                        runColor = color;
                        runLength = 1;
                    }
                }
                result += TerminateRun(runLength, runColor, runHistory) * 40;
            }

            for (int y = 0; y < _size - 1; y++)
            {
                for (int x = 0; x < _size - 1; x++)
                {
                    bool color = _modules[y, x];
                    if (color == _modules[y, x + 1] && color == _modules[y + 1, x]
                        && color == _modules[y + 1, x + 1])
                    {
                        result += 3;
                    }
                }
            }

            int dark = 0;
            for (int y = 0; y < _size; y++)
            {
                for (int x = 0; x < _size; x++) if (_modules[y, x]) dark++;
            }
            int total = _size * _size;
            int k2 = (Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1;
            result += k2 * 10;
            return result;
        }

        /// <summary>
        /// The quiet zone counts as a run of light modules of the code's own width, which is
        /// what lets a finder pattern touching the edge be scored (ISO/IEC 18004 §7.8.3.1).
        /// </summary>
        private void AddRunToHistory(int runLength, int[] history)
        {
            if (history[0] == 0) runLength += _size;
            Array.Copy(history, 0, history, 1, history.Length - 1);
            history[0] = runLength;
        }

        private int TerminateRun(int runLength, bool runColor, int[] history)
        {
            if (runColor)
            {
                AddRunToHistory(runLength, history);
                runLength = 0;
            }
            runLength += _size;
            AddRunToHistory(runLength, history);
            return CountPatterns(history);
        }

        /// <summary>Counts 1:1:3:1:1 finder-like patterns with a 4-module quiet zone.</summary>
        private static int CountPatterns(int[] history)
        {
            int n = history[1];
            bool core = n > 0 && history[2] == n && history[3] == n * 3
                        && history[4] == n && history[5] == n;
            return ((core && history[0] >= n * 4 && history[6] >= n) ? 1 : 0)
                   + ((core && history[6] >= n * 4 && history[0] >= n) ? 1 : 0);
        }

        /// <summary>
        /// Total codewords (data + EC) per version, ISO/IEC 18004 table 9, versions 1–10.
        /// Taken from the standard rather than derived from the module count: deriving it
        /// needs the exact overlap accounting of alignment patterns against timing patterns,
        /// and a one-module error there silently corrupts every codeword.
        /// </summary>
        private static readonly int[] TotalCodewords = { 26, 44, 70, 100, 134, 172, 196, 242, 292, 346 };

        private static int RawCodewords(int version)
        {
            return TotalCodewords[version - 1];
        }
    }
}
