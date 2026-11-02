//! A journalled lease: restore only when the current registry values still match our changes.
//! Registry writes are exercised only by explicitly enabled system-proxy integration tests.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::io;
    use winreg::{enums::*, types::ToRegValue, RegKey, RegValue};

    const KEYS: [&str; 4] = [
        "ProxyEnable",
        "ProxyServer",
        "ProxyOverride",
        "AutoConfigURL",
    ];

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct StoredValue {
        bytes: Vec<u8>,
        kind: u32,
    }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct Values(Vec<Option<StoredValue>>);
    #[derive(Clone, Debug, Serialize, Deserialize)]
    struct Lease {
        previous: Values,
        applied: Values,
    }

    fn registry() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                KEY_READ | KEY_WRITE,
            )
            .map_err(|e| format!("无法访问 Windows 系统代理设置：{e}"))
    }
    fn snapshot(reg: &RegKey) -> Result<Values, String> {
        KEYS.iter()
            .map(|name| match reg.get_raw_value(name) {
                Ok(value) => Ok(Some(StoredValue {
                    bytes: value.bytes,
                    kind: value.vtype as u32,
                })),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Values)
    }
    fn raw(value: &StoredValue) -> Result<RegValue, String> {
        let vtype = match value.kind {
            0 => REG_NONE,
            1 => REG_SZ,
            2 => REG_EXPAND_SZ,
            3 => REG_BINARY,
            4 => REG_DWORD,
            5 => REG_DWORD_BIG_ENDIAN,
            6 => REG_LINK,
            7 => REG_MULTI_SZ,
            8 => REG_RESOURCE_LIST,
            9 => REG_FULL_RESOURCE_DESCRIPTOR,
            10 => REG_RESOURCE_REQUIREMENTS_LIST,
            11 => REG_QWORD,
            _ => return Err("系统代理备份包含不支持的注册表类型".into()),
        };
        Ok(RegValue {
            bytes: value.bytes.clone(),
            vtype,
        })
    }
    fn write(reg: &RegKey, values: &Values) -> Result<(), String> {
        if values.0.len() != KEYS.len() {
            return Err("系统代理恢复记录无效".into());
        }
        for (name, value) in KEYS.iter().zip(&values.0) {
            match value {
                Some(value) => reg
                    .set_raw_value(name, &raw(value)?)
                    .map_err(|e| e.to_string())?,
                None => match reg.delete_value(name) {
                    Ok(()) => (),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.to_string()),
                },
            }
        }
        notify_windows();
        Ok(())
    }
    fn stored(value: RegValue) -> Option<StoredValue> {
        Some(StoredValue {
            bytes: value.bytes,
            kind: value.vtype as u32,
        })
    }
    fn notify_windows() {
        #[link(name = "wininet")]
        extern "system" {
            fn InternetSetOptionW(
                internet: *mut std::ffi::c_void,
                option: u32,
                buffer: *mut std::ffi::c_void,
                length: u32,
            ) -> i32;
        }
        unsafe {
            InternetSetOptionW(std::ptr::null_mut(), 39, std::ptr::null_mut(), 0);
            InternetSetOptionW(std::ptr::null_mut(), 37, std::ptr::null_mut(), 0);
        }
    }

    pub fn apply(path: &Path, port: u16) -> Result<(), String> {
        if path.exists() {
            restore(path)?;
        }
        let reg = registry()?;
        let previous = snapshot(&reg)?;
        let applied = Values(vec![
            stored(1u32.to_reg_value()),
            stored(format!("127.0.0.1:{port}").to_reg_value()),
            stored("<local>;localhost;127.*;[::1]".to_reg_value()),
            None,
        ]);
        let lease = Lease { previous, applied };
        std::fs::write(path, serde_json::to_vec(&lease).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if let Err(error) = write(&reg, &lease.applied) {
            // A partial write must be rolled back before the journal is removed.
            if write(&reg, &lease.previous).is_ok() {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
        Ok(())
    }
    pub fn restore(path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let lease: Lease = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let reg = registry()?;
        // If another application or the user changed these values, relinquish ownership.
        if snapshot(&reg)? == lease.applied {
            write(&reg, &lease.previous)?;
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
pub use platform::{apply, restore};

#[cfg(not(windows))]
pub fn apply(_: &Path, _: u16) -> Result<(), String> {
    Err("系统代理目前仅支持 Windows".into())
}
#[cfg(not(windows))]
pub fn restore(_: &Path) -> Result<(), String> {
    Ok(())
}
