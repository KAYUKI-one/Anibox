#[cfg(windows)]
pub fn apply(window: &tauri::Window) {
    use std::sync::Mutex;
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn},
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{GetWindowRect, IsIconic, IsZoomed},
        },
    };
    static LAST: Mutex<Option<(isize, i32, i32, u32, bool)>> = Mutex::new(None);
    let Ok(handle) = window.hwnd() else {
        return;
    };
    unsafe {
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
