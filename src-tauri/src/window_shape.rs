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
