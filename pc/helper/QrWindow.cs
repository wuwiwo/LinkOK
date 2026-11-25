// LinkOK helper — the QR display window (SPEC §5.5).
//
// "配对新设备" pops a small, always-on-top window showing the pairing QR. The code is
// rendered from the payload by QrCode.cs, so no image file and no package is involved.
// If the payload is too long for the encoder, the window says so and shows the payload as
// text instead — visibly degraded, never silently blank.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

namespace LinkOK.Helper
{
    internal sealed class QrForm : Form
    {
        private readonly string _payload;
        private readonly QrCode _code;
        private readonly Label _caption;
        private readonly Panel _canvas;
        private readonly ToolTip _tips = new ToolTip();
        private Bitmap _bitmap;

        private const int Modules = 4;      // pixels per module at 100%
        private const int QuietZone = 4;    // modules of quiet zone required by the spec
        private const int MaxCanvas = 520;

        public QrForm(string payload)
        {
            _payload = payload ?? string.Empty;
            SuspendLayout();
            _code = QrCode.EncodeText(_payload);

            Text = "LinkOK — 配对新设备";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            ShowInTaskbar = true;
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;

            int side = _code == null ? 240 : _code.Size * Modules + QuietZone * 2 * Modules;
            side = Math.Min(side, MaxCanvas);

            _canvas = new Panel();
            _canvas.Width = side;
            _canvas.Height = side;
            _canvas.BackColor = Color.White;
            _canvas.Left = 16;
            _canvas.Top = 16;
            _canvas.Paint += OnCanvasPaint;

            _caption = new Label();
            _caption.AutoSize = false;
            _caption.Left = 16;
            _caption.Top = 16 + side + 10;
            _caption.Width = side;
            _caption.Height = 58;
            _caption.TextAlign = ContentAlignment.MiddleCenter;
            _caption.ForeColor = Color.FromArgb(0x44, 0x44, 0x44);
            _caption.Text = _code == null
                ? "二维码内容过长，显示为文本：\r\n" + Truncate(_payload, 120)
                : "用手机 LinkOK 扫码配对\r\n配对码 120 秒内有效";

            ClientSize = new Size(side + 32, 16 + side + 10 + 58 + 16);
            Controls.Add(_canvas);
            Controls.Add(_caption);
            _tips.SetToolTip(_canvas, _payload);

            KeyPreview = true;
            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) Hide();
            };
            ResumeLayout();
        }

        /// <summary>The payload that could not be encoded, or null when it encoded fine.</summary>
        public bool Encoded
        {
            get { return _code != null; }
        }

        public void ShowCentered()
        {
            if (!Visible) Show();
            else
            {
                Activate();
                BringToFront();
            }
        }

        private void OnCanvasPaint(object sender, PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.None;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
            e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
            e.Graphics.Clear(Color.White);

            if (_code == null)
            {
                DrawTextFallback(e.Graphics);
                return;
            }

            Bitmap bitmap = GetBitmap();
            if (bitmap == null) return;

            int drawSize = Math.Min(_canvas.Width, _canvas.Height);
            e.Graphics.DrawImage(bitmap, new Rectangle(0, 0, drawSize, drawSize),
                new Rectangle(0, 0, bitmap.Width, bitmap.Height), GraphicsUnit.Pixel);
        }

        private void DrawTextFallback(Graphics g)
        {
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(0x33, 0x33, 0x33)))
            using (Font font = new Font("Consolas", 8.5f))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Near;
                format.LineAlignment = StringAlignment.Near;
                RectangleF rect = new RectangleF(8, 8, _canvas.Width - 16, _canvas.Height - 16);
                g.DrawString("无法绘制二维码（载荷超过编码器上限）\r\n\r\n" + _payload,
                    font, brush, rect, format);
            }
        }

        /// <summary>One bitmap per code, module-aligned so the edges stay hard.</summary>
        private Bitmap GetBitmap()
        {
            if (_bitmap != null) return _bitmap;
            if (_code == null) return null;

            int modulesWithQuiet = _code.Size + QuietZone * 2;
            _bitmap = new Bitmap(modulesWithQuiet, modulesWithQuiet, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(_bitmap))
            using (SolidBrush dark = new SolidBrush(Color.Black))
            {
                g.Clear(Color.White);
                for (int y = 0; y < _code.Size; y++)
                {
                    for (int x = 0; x < _code.Size; x++)
                    {
                        if (!_code[x, y]) continue;
                        g.FillRectangle(dark, x + QuietZone, y + QuietZone, 1, 1);
                    }
                }
            }
            return _bitmap;
        }

        private static string Truncate(string text, int max)
        {
            if (text == null) return string.Empty;
            return text.Length <= max ? text : text.Substring(0, max) + "…";
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_bitmap != null)
                {
                    _bitmap.Dispose();
                    _bitmap = null;
                }
                _tips.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
