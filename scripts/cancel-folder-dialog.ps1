param([Parameter(Mandatory=$true)][int]$ApplicationProcessId)
$ErrorActionPreference='Stop'
$expected=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) '.local\qa\Anibox\Anibox.exe'))
if((Get-Process -Id $ApplicationProcessId).Path -ne $expected){throw 'Only the isolated QA dialog may be closed.'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AniboxFolderDialog {
  delegate bool Callback(IntPtr window,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int count);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  public static void Cancel(int process) {
    for(int attempt=0;attempt<60;attempt++) {
      IntPtr dialog=IntPtr.Zero;
      EnumWindows((window,data)=>{
        uint owner; GetWindowThreadProcessId(window,out owner);
        var name=new StringBuilder(256); GetClassName(window,name,name.Capacity);
        if(owner==process && name.ToString()=="#32770") {dialog=window;return false;}
        return true;
      },IntPtr.Zero);
      if(dialog!=IntPtr.Zero){PostMessage(dialog,0x10,IntPtr.Zero,IntPtr.Zero);return;}
      Thread.Sleep(100);
    }
    throw new Exception("QA folder picker did not appear");
  }
}
'@
[AniboxFolderDialog]::Cancel($ApplicationProcessId)
