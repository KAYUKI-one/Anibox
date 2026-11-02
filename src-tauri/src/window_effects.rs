//! Use the supported DWM compositor, never the legacy Accent blur path.
//! Accent blur causes black surfaces and drag/resize stalls on recent Windows 11.
#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::{
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmSetWindowAttribute, DWMSBT_TRANSIENTWINDOW,
            DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
        },
        UI::Controls::MARGINS,
    };

    let glass = window.hwnd().is_ok_and(|handle| unsafe {
        let light: i32 = 0;
        let _ = DwmSetWindowAttribute(
            handle.0,
            DWMWA_USE_IMMERSIVE_DARK_MODE as _,
            &light as *const _ as _,
            std::mem::size_of_val(&light) as _,
        );
        // Frameless WebView windows need glass extended over the client area.
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        let backdrop = DWMSBT_TRANSIENTWINDOW;
        DwmExtendFrameIntoClientArea(handle.0, &margins) >= 0
            && DwmSetWindowAttribute(
                handle.0,
                DWMWA_SYSTEMBACKDROP_TYPE as _,
                &backdrop as *const _ as _,
                std::mem::size_of_val(&backdrop) as _,
            ) >= 0
    });
    if !glass {
        // Windows 10 / older Windows 11: stable light surface instead of an
        // unsupported effect or a transparent WebView revealing a black HWND.
        let _ = window.set_background_color(Some(tauri::window::Color(232, 241, 247, 255)));
    }
}
