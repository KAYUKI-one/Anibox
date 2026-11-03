#[cfg(windows)]
pub fn install(window: &tauri::Window) -> Result<(), String> {
    use windows_sys::Win32::{
        Graphics::Dwm::{DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_NCRENDERING_POLICY},
        UI::Shell::SetWindowSubclass,
    };
    let handle = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        if SetWindowSubclass(handle.0, Some(borderless_proc), 0x414e4942, 0) == 0 {
            return Err(format!(
                "无法初始化无边框窗口：{}",
                std::io::Error::last_os_error()
            ));
        }
        let policy = DWMNCRP_DISABLED;
        let _ = DwmSetWindowAttribute(
            handle.0,
            DWMWA_NCRENDERING_POLICY as u32,
            &policy as *const _ as _,
            std::mem::size_of_val(&policy) as u32,
        );
    }
    apply(window);
    Ok(())
}

#[cfg(windows)]
unsafe extern "system" fn borderless_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    _: usize,
) -> isize {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::*,
    };
    match message {
        WM_NCPAINT | 0x00ae | 0x00af => 0,
        // Keep Tao's activation/focus bookkeeping, but prevent DefWindowProc from
        // painting a native caption into the transparent client surface on Alt+Tab.
        WM_NCACTIVATE if IsIconic(hwnd) == 0 => DefSubclassProc(hwnd, message, wparam, -1),
        WM_STYLECHANGING if lparam != 0 => {
            let style = &mut *(lparam as *mut STYLESTRUCT);
            if wparam as i32 == GWL_STYLE {
                style.styleNew &= !WS_CAPTION;
            }
            if wparam as i32 == GWL_EXSTYLE {
                style.styleNew &= !(WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME);
            }
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(borderless_proc), id);
            DefSubclassProc(hwnd, message, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, message, wparam, lparam),
    }
}

#[cfg(windows)]
pub fn apply(window: &tauri::Window) {
    use std::sync::Mutex;
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn},
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                GetWindowLongPtrW, GetWindowRect, IsIconic, IsZoomed, SetWindowLongPtrW,
                SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
                SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME,
                WS_EX_WINDOWEDGE,
            },
        },
    };
    static LAST: Mutex<Option<(isize, i32, i32, u32, bool)>> = Mutex::new(None);
    let Ok(handle) = window.hwnd() else {
        return;
    };
    unsafe {
        // Tao retains WS_CAPTION for native resizing. Its non-client painter can leak the
        // system icon and a white caption into transparent pixels after activation/resize.
        // Its undecorated hit testing still handles resizing without that caption style.
        let style = GetWindowLongPtrW(handle.0, GWL_STYLE);
        let extended = GetWindowLongPtrW(handle.0, GWL_EXSTYLE);
        let clean_style = style & !(WS_CAPTION as isize);
        let clean_extended =
            extended & !((WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME) as isize);
        if style != clean_style || extended != clean_extended {
            SetWindowLongPtrW(handle.0, GWL_STYLE, clean_style);
            SetWindowLongPtrW(handle.0, GWL_EXSTYLE, clean_extended);
            SetWindowPos(
                handle.0,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        if IsIconic(handle.0) != 0 {
            return;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(handle.0, &mut rect) == 0 {
            return;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let dpi = GetDpiForWindow(handle.0).max(96);
        let maximized = IsZoomed(handle.0) != 0;
        let key = (handle.0 as isize, width, height, dpi, maximized);
        {
            let Ok(mut last) = LAST.lock() else {
                return;
            };
            if *last == Some(key) {
                return;
            }
            *last = Some(key);
        }
        if maximized {
            SetWindowRgn(handle.0, std::ptr::null_mut(), 1);
            return;
        }
        let diameter = (64 * dpi / 96) as i32;
        let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
        // Successful SetWindowRgn transfers ownership of the region to Windows.
        if !region.is_null() && SetWindowRgn(handle.0, region, 1) == 0 {
            DeleteObject(region);
        }
    }
}
