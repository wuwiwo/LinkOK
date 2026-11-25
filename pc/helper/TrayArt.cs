// LinkOK helper — tray icon artwork, drawn in code.
//
// SPEC §5.8 / §6.1: three states — connected (normal), disconnected (grey), paused (slash).
// There are no external image files in this repo, so every icon is rasterised here with
// System.Drawing and handed to the tray as an HICON. Icons are drawn at 32px and let
// Windows downscale, which stays crisp on 100–200% DPI.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace LinkOK.Helper
{
    internal enum TrayState
    {
        Connected = 0,
        Disconnected = 1,
        Paused = 2
    }

    internal static class TrayArt
    {
        private const int Size = 32;

        // The M3-ish blue used across LinkOK (SPEC §6.1: a bluish primary, no semantic
        // green/yellow/red — "已连接" is primary, "未连接" is a grey outline colour).
        private static readonly Color Primary = Color.FromArgb(0x4C, 0x8D, 0xF6);
        private static readonly Color PrimaryDeep = Color.FromArgb(0x2A, 0x5F, 0xC4);
        private static readonly Color Outline = Color.FromArgb(0x8A, 0x8A, 0x8A);
        private static readonly Color OutlineDeep = Color.FromArgb(0x5A, 0x5A, 0x5A);
        private static readonly Color Surface = Color.FromArgb(0xFF, 0xFF, 0xFF);
        private static readonly Color Slash = Color.FromArgb(0xE5, 0x3E, 0x3E);

        public static Icon Create(TrayState state)
        {
            using (Bitmap bitmap = new Bitmap(Size, Size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.Transparent);

                    switch (state)
                    {
                        case TrayState.Connected:
                            DrawBridge(g, Primary, PrimaryDeep, true);
                            break;
                        case TrayState.Disconnected:
                            DrawBridge(g, Outline, OutlineDeep, false);
                            break;
                        case TrayState.Paused:
                            DrawBridge(g, Outline, OutlineDeep, false);
                            DrawPauseBadge(g);
                            break;
                    }
                }
                IntPtr handle = bitmap.GetHicon();
                try
                {
                    // Clone so the Icon owns a private copy; the HICON is destroyed below.
                    using (Icon temporary = Icon.FromHandle(handle))
                    {
                        return (Icon)temporary.Clone();
                    }
                }
                finally
                {
                    NativeMethods.DestroyIcon(handle);
                }
            }
        }

        /// <summary>
        /// Two rounded squares joined by a bar — the "Link" mark: phone on the right, PC on
        /// the left. Connected uses the primary blue, disconnected a neutral grey.
        /// </summary>
        private static void DrawBridge(Graphics g, Color body, Color edge, bool filled)
        {
            Rectangle left = new Rectangle(2, 11, 9, 11);
            Rectangle right = new Rectangle(21, 11, 9, 11);
            Rectangle bar = new Rectangle(10, 15, 12, 3);

            using (SolidBrush fill = new SolidBrush(filled ? body : Surface))
            using (Pen stroke = new Pen(edge, 2f))
            {
                using (GraphicsPath leftPath = RoundedRect(left, 2))
                using (GraphicsPath rightPath = RoundedRect(right, 2))
                {
                    g.FillPath(fill, leftPath);
                    g.DrawPath(stroke, leftPath);
                    g.FillPath(fill, rightPath);
                    g.DrawPath(stroke, rightPath);
                }
                using (SolidBrush barBrush = new SolidBrush(edge))
                {
                    g.FillRectangle(barBrush, bar);
                }
            }
        }

        private static void DrawPauseBadge(Graphics g)
        {
            // A diagonal slash across the bridge, plus a dot-free "paused" read at 16px.
            using (Pen slash = new Pen(Slash, 3.2f))
            {
                slash.StartCap = LineCap.Round;
                slash.EndCap = LineCap.Round;
                g.DrawLine(slash, 4, 26, 28, 6);
            }
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int diameter = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>Placeholder icon for cases Windows still asks for one.</summary>
        public static Icon Fallback()
        {
            return SystemIcons.Application;
        }
    }
}
