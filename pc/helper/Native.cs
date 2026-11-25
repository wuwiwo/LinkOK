// LinkOK helper — Win32 interop.
//
// The clipboard is handled with the raw Win32 API rather than System.Windows.Forms.Clipboard:
//   * no OLE clipboard / STA apartment requirement, so the retry loops can run on a worker
//     thread while the UI thread keeps pumping messages;
//   * we control which formats are read and written (CF_DIB / CF_DIBV5 / PNG / CF_BITMAP);
//   * contention (another app holding the clipboard) surfaces as a false return that we can
//     retry and ultimately report instead of an opaque exception.

using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace LinkOK.Helper
{
    internal static class NativeMethods
    {
        public const int WM_CLIPBOARDUPDATE = 0x031D;
        public const int WM_APP = 0x8000;

        public static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        // Clipboard formats
        public const uint CF_TEXT = 1;
        public const uint CF_BITMAP = 2;
        public const uint CF_DIB = 8;
        public const uint CF_UNICODETEXT = 13;
        public const uint CF_DIBV5 = 17;

        // GlobalAlloc flags
        public const uint GMEM_MOVEABLE = 0x0002;
        public const uint GMEM_ZEROINIT = 0x0040;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AddClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint RegisterClipboardFormat(string lpszFormat);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint EnumClipboardFormats(uint format);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalFree(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalLock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GlobalUnlock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern UIntPtr GlobalSize(IntPtr hMem);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern int Shell_NotifyIcon(int dwMessage, ref NOTIFYICONDATA lpData);

        /// <summary>Format id of the registered "PNG" clipboard format, or 0 if unavailable.</summary>
        public static uint PngFormatId()
        {
            return RegisterClipboardFormat("PNG");
        }
    }

    /// <summary>
    /// A message-only window (HWND_MESSAGE parent).
    ///
    /// PROTOCOL/SPEC: clipboard changes arrive as WM_CLIPBOARDUPDATE, which requires a
    /// real HWND registered through AddClipboardFormatListener. A message-only window
    /// gives us one without ever appearing on screen or in the taskbar.
    /// </summary>
    internal sealed class MessageWindow : NativeWindow, IDisposable
    {
        public event EventHandler ClipboardUpdate;

        private bool _listening;
        private bool _disposed;

        public MessageWindow()
        {
            CreateParams cp = new CreateParams();
            cp.Caption = "LinkOK.Helper.ClipboardListener";
            cp.Parent = NativeMethods.HWND_MESSAGE;
            cp.Style = 0;
            cp.ExStyle = 0;
            CreateHandle(cp);
        }

        public bool StartListening()
        {
            if (_listening) return true;
            _listening = NativeMethods.AddClipboardFormatListener(Handle);
            if (!_listening)
            {
                int err = Marshal.GetLastWin32Error();
                Log.Error("AddClipboardFormatListener failed, win32=" + err);
            }
            return _listening;
        }

        public void StopListening()
        {
            if (!_listening) return;
            NativeMethods.RemoveClipboardFormatListener(Handle);
            _listening = false;
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == NativeMethods.WM_CLIPBOARDUPDATE)
            {
                EventHandler handler = ClipboardUpdate;
                if (handler != null)
                {
                    // Never let a listener exception kill the message pump silently.
                    try
                    {
                        handler(this, EventArgs.Empty);
                    }
                    catch (Exception ex)
                    {
                        Log.Error("clipboard update handler threw: " + Paths.Describe(ex));
                    }
                }
                return;
            }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            StopListening();
            if (Handle != IntPtr.Zero) DestroyHandle();
        }
    }

    /// <summary>NOTIFYICONDATAW, abridged to the fields the helper fills in.</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct NOTIFYICONDATA
    {
        public int cbSize;
        public IntPtr hWnd;
        public int uID;
        public int uFlags;
        public int uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;
        public int dwState;
        public int dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public int uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public int dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }
}
