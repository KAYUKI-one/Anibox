param([Parameter(Mandatory=$true)][int]$ApplicationProcessId)
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.local\qa\Anibox\Anibox.exe'))
if ((Get-Process -Id $ApplicationProcessId).Path -ne $expected) { throw 'Window checks only target the isolated QA executable.' }
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class AniboxWindowCheck {
    delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, uint size);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    class Backdrop : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p=base.CreateParams; p.ExStyle |= 0x08000080; return p; } }
    }
    static Color Sample(IntPtr window, double x, double y) {
        var origin = new Point(0,0);
        ClientToScreen(window, ref origin);
        double scale = GetDpiForWindow(window) / 96.0;
        IntPtr dc = GetDC(IntPtr.Zero);
        try {
            uint pixel = GetPixel(dc, origin.X + (int)(x*scale), origin.Y + (int)(y*scale));
            return Color.FromArgb((int)(pixel & 255), (int)((pixel >> 8) & 255), (int)((pixel >> 16) & 255));
        } finally { ReleaseDC(IntPtr.Zero, dc); }
    }
    static void Frame() { Application.DoEvents(); DwmFlush(); Thread.Sleep(45); }
    public static string Check(int processId) {
        SetProcessDPIAware();
        IntPtr window = IntPtr.Zero;
        EnumWindows((hwnd, parameter) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId) return true;
            var title = new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);
            if (!title.ToString().StartsWith("Anibox")) return true;
            window=hwnd; return false;
        },IntPtr.Zero);
        if(window==IntPtr.Zero) throw new Exception("QA window not found");
        int material;
        if(DwmGetWindowAttribute(window,38,out material,4)==0 && material!=1 && material!=0)
            throw new Exception("Acrylic/Mica tint must be disabled");
        Rect original;
        if(!GetWindowRect(window,out original)) throw new Exception("Cannot read window bounds");
        var watch=Stopwatch.StartNew();
        using(var backdrop=new Backdrop()) {
            backdrop.FormBorderStyle=FormBorderStyle.None;
            backdrop.ShowInTaskbar=false; backdrop.TopMost=true;
            backdrop.StartPosition=FormStartPosition.Manual;
            backdrop.Bounds=new Rectangle(20,20,original.right-original.left+120,original.bottom-original.top+120);
            backdrop.BackColor=Color.FromArgb(35,120,210);
            try {
                backdrop.Show();
                SetWindowPos(backdrop.Handle,new IntPtr(-1),20,20,0,0,0x51); Frame();
                Color backdropBlue=Sample(backdrop.Handle,5,5);
                SetWindowPos(window,new IntPtr(-1),40,40,0,0,0x51);
                SetWindowPos(backdrop.Handle,window,20,20,0,0,0x11);
                Frame();
                Color sidebar=Sample(window,40,100);
                if(sidebar.B>110 || sidebar.G>110) throw new Exception("QA content is not visible: "+sidebar+" backdrop="+backdropBlue);
                Color blue=Sample(window,90,80);
                backdrop.BackColor=Color.FromArgb(215,70,85); Frame();
                Color backdropPink=Sample(backdrop.Handle,5,5);
                Color pink=Sample(window,90,80);
                if(pink.R-blue.R<140 || blue.B-pink.B<90)
                    throw new Exception("Outer glass is tinted/opaque: blue="+blue+", pink="+pink+", known backdrop="+backdropBlue+"/"+backdropPink+", sidebar="+sidebar);
                for(int i=0;i<16;i++) {
                    SetWindowPos(window,new IntPtr(-1),40+(i%4)*12,40+(i%3)*8,0,0,0x11);
                    Frame();
                    Color moved=Sample(window,90,80);
                    if(moved.R<170 || moved.G>110 || moved.B>125) throw new Exception("Transparency was lost while moving: "+moved);
                }
                return "PASS actual background transmission (blue="+blue+", pink="+pink+"), 16 transparent window moves in "+watch.ElapsedMilliseconds+" ms";
            } finally {
                ShowWindow(window,0);
                SetWindowPos(window,new IntPtr(-2),original.left,original.top,0,0,0x11);
                backdrop.Close();
            }
        }
    }
}
'@
[AniboxWindowCheck]::Check($ApplicationProcessId)
