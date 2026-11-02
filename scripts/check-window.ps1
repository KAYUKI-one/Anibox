param([Parameter(Mandatory=$true)][int]$ApplicationProcessId, [switch]$GeometryOnly)
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
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll", EntryPoint="SendMessageW")] static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left,int top,int right,int bottom);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window,IntPtr region);
    [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr region,int x,int y);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr region);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, uint size);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    class Backdrop : Form {
        protected override void OnPaintBackground(PaintEventArgs e) { e.Graphics.Clear(BackColor); }
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
    public static string Check(int processId, bool geometryOnly) {
        SetProcessDPIAware();
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr window = IntPtr.Zero;
        EnumWindows((hwnd, parameter) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId) return true;
            var title = new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);
            if (!title.ToString().StartsWith("Anibox")) return true;
            window=hwnd; return false;
        },IntPtr.Zero);
        if(window==IntPtr.Zero) throw new Exception("QA window not found");
        if((GetWindowLongPtr(window,-16).ToInt64() & 0x00C00000)!=0)
            throw new Exception("Native caption can paint an icon/white bar into the glass");
        int material;
        if(DwmGetWindowAttribute(window,38,out material,4)==0 && material!=1 && material!=0)
            throw new Exception("Acrylic/Mica tint must be disabled");
        Rect original;
        if(!GetWindowRect(window,out original)) throw new Exception("Cannot read window bounds");
        var clientOrigin=new Point(0,0); ClientToScreen(window,ref clientOrigin);
        if(clientOrigin.X!=original.left || clientOrigin.Y!=original.top)
            throw new Exception("Transparent content must cover the native frame without non-client insets");
        if(geometryOnly) {
            IntPtr shape=CreateRectRgn(0,0,0,0);
            int kind=GetWindowRgn(window,shape);
            bool corner=PtInRegion(shape,1,1), center=PtInRegion(shape,100,100);
            DeleteObject(shape);
            if(kind!=3 || corner || !center) throw new Exception("Native round clipping is missing");
            int middleX=(original.left+original.right)/2, middleY=(original.top+original.bottom)/2;
            int[] xs={original.left+2,original.right-2,middleX,middleX};
            int[] ys={middleY,middleY,original.top+2,original.bottom-2};
            int[] edges={10,11,12,15};
            for(int i=0;i<edges.Length;i++) {
                long point=((uint)(ushort)ys[i]<<16)|(uint)(ushort)xs[i];
                if(SendMessage(window,0x84,IntPtr.Zero,new IntPtr(point)).ToInt32()!=edges[i])
                    throw new Exception("Borderless resizing is broken at edge "+edges[i]);
            }
            return "PASS native frame has no caption/icon or non-client insets; rounded clipping and all four resize edges work";
        }
        var watch=Stopwatch.StartNew();
        using(var backdrop=new Backdrop()) {
            backdrop.FormBorderStyle=FormBorderStyle.None;
            backdrop.ShowInTaskbar=false; backdrop.TopMost=true;
            backdrop.StartPosition=FormStartPosition.Manual;
            backdrop.Bounds=new Rectangle(0,0,original.right-original.left+240,original.bottom-original.top+240);
            backdrop.BackColor=Color.FromArgb(35,120,210);
            try {
                backdrop.Show(); backdrop.Refresh();
                SetWindowPos(backdrop.Handle,new IntPtr(-1),0,0,0,0,0x51); Frame();
                Color backdropBlue=Sample(backdrop.Handle,100,100);
                if(Math.Abs(backdropBlue.R-35)>8 || Math.Abs(backdropBlue.G-120)>8 || Math.Abs(backdropBlue.B-210)>8)
                    throw new Exception("The test backdrop is obscured; pixel checks require an unobstructed desktop. Use -GeometryOnly for native frame checks.");
                SetWindowPos(window,new IntPtr(-1),160,160,0,0,0x51);
                SetWindowPos(backdrop.Handle,window,0,0,0,0,0x11);
                Frame();
                Color sidebar=Sample(window,40,100);
                if(sidebar.B>110 || sidebar.G>110 || sidebar.B-sidebar.R<12 || sidebar.G-sidebar.R<6) throw new Exception("QA content is not visible: "+sidebar+" backdrop="+backdropBlue);
                Color blue=Sample(window,90,80);
                Color blueCorner=Sample(window,1,1);
                var origin=new Point(0,0); ClientToScreen(window,ref origin);
                Rect current; GetWindowRect(window,out current);
                IntPtr region=CreateRectRgn(0,0,0,0); int regionType=GetWindowRgn(window,region);
                bool cornerInside=PtInRegion(region,origin.X-current.left+1,origin.Y-current.top+1);
                DeleteObject(region);
                if(regionType!=3 || cornerInside || Math.Abs(blueCorner.R-35)>8 || Math.Abs(blueCorner.G-120)>8 || Math.Abs(blueCorner.B-210)>8)
                    throw new Exception("The outer corner is not clipped to a transparent round: "+blueCorner+" backdrop="+backdropBlue+" region="+regionType+" included="+cornerInside+" client="+origin+" bounds="+current.left+","+current.top+" dpi="+GetDpiForWindow(window));
                backdrop.BackColor=Color.FromArgb(215,70,85); backdrop.Refresh(); Frame();
                Color backdropPink=Sample(backdrop.Handle,100,100);
                Color pink=Sample(window,90,80);
                if(pink.R-blue.R<140 || blue.B-pink.B<90)
                    throw new Exception("Outer glass is tinted/opaque: blue="+blue+", pink="+pink+", known backdrop="+backdropBlue+"/"+backdropPink+", sidebar="+sidebar);
                for(int i=0;i<16;i++) {
                    SetWindowPos(window,new IntPtr(-1),160+(i%4)*12,160+(i%3)*8,0,0,0x11);
                    Frame();
                    Color moved=Sample(window,90,80);
                    if(moved.R<170 || moved.G>110 || moved.B>125) throw new Exception("Transparency was lost while moving: "+moved);
                }
                for(int i=0;i<4;i++) {
                    SetWindowPos(window,new IntPtr(-1),160,160,original.right-original.left+20*(i+1),original.bottom-original.top+16*(i+1),0x10);
                    Frame();
                    region=CreateRectRgn(0,0,0,0);
                    regionType=GetWindowRgn(window,region);
                    bool centerInside=PtInRegion(region,100,100);
                    bool outerInside=PtInRegion(region,1,1);
                    DeleteObject(region);
                    if(regionType!=3 || outerInside || !centerInside) throw new Exception("Rounded window region was lost on resize");
                }
                return "PASS rounded transparent corner, 4 resizes, background transmission (blue="+blue+", pink="+pink+"), 16 transparent window moves in "+watch.ElapsedMilliseconds+" ms";
            } finally {
                ShowWindow(window,0);
                SetWindowPos(window,new IntPtr(-2),original.left,original.top,original.right-original.left,original.bottom-original.top,0x10);
                backdrop.Close();
            }
        }
    }
}
'@
[AniboxWindowCheck]::Check($ApplicationProcessId, [bool]$GeometryOnly)
