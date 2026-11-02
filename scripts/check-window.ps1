param([Parameter(Mandatory=$true)][int]$ApplicationProcessId)
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.local\qa\Anibox\Anibox.exe'))
if ((Get-Process -Id $ApplicationProcessId).Path -ne $expected) { throw 'Window checks only target the isolated QA executable.' }
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class AniboxWindowCheck {
    delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, uint size);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    public static string Check(int processId) {
        SetProcessDPIAware();
        IntPtr window = IntPtr.Zero;
        EnumWindows((hwnd, parameter) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != processId) return true;
            var title = new StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity);
            if (!title.ToString().StartsWith("Anibox")) return true;
            window = hwnd;
            return false;
        }, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new Exception("QA main window not found");
        int backdrop, dark;
        if (DwmGetWindowAttribute(window, 38, out backdrop, 4) != 0 || backdrop != 3)
            throw new Exception("Modern Desktop Acrylic was not activated (run this check on Windows 11 22H2+)");
        if (DwmGetWindowAttribute(window, 20, out dark, 4) != 0 || dark != 0)
            throw new Exception("The backdrop must use the application's light theme");
        Rect original;
        if (!GetWindowRect(window, out original)) throw new Exception("Cannot read QA window bounds");
        var elapsed = Stopwatch.StartNew();
        try {
            ShowWindow(window, 4); // SW_SHOWNOACTIVATE
            for (int i = 0; i < 16; i++) {
                if (!SetWindowPos(window, IntPtr.Zero, original.left + (i % 4) * 12, original.top + (i % 3) * 8, 0, 0, 0x15))
                    throw new Exception("Window move failed");
                DwmFlush();
            }
        } finally {
            SetWindowPos(window, IntPtr.Zero, original.left, original.top, 0, 0, 0x15);
            ShowWindow(window, 0);
        }
        return "PASS modern DWM acrylic, light theme, 16 composed window moves in " + elapsed.ElapsedMilliseconds + " ms";
    }
}
'@
[AniboxWindowCheck]::Check($ApplicationProcessId)
