use std::{
    collections::VecDeque,
    io::Read,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Default)]
pub struct CoreOutput {
    bytes: Arc<Mutex<VecDeque<u8>>>,
    readers: Vec<thread::JoinHandle<()>>,
    file: Option<crate::log_files::Writer>,
}
impl CoreOutput {
    pub fn enable_file(&mut self, path: std::path::PathBuf) {
        self.file = Some(crate::log_files::Writer::new(path));
    }
    pub fn drain(&mut self, mut reader: impl Read + Send + 'static) {
        let bytes = self.bytes.clone();
        let file = self.file.clone();
        self.readers.push(thread::spawn(move || {
            let mut chunk = [0; 2048];
            while let Ok(count) = reader.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let Ok(mut bytes) = bytes.lock() else {
                    break;
                };
                bytes.extend(&chunk[..count]);
                let excess = bytes.len().saturating_sub(16 * 1024);
                bytes.drain(..excess);
                if let Some(file) = &file {
                    file.write(&chunk[..count]);
                }
            }
        }));
    }
    // Join only after the child exits, when its pipe writers have closed.
    pub fn finish(&mut self) {
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        if let Some(file) = &self.file {
            let _ = file.flush();
        }
    }
    pub fn clear(&mut self) -> Result<(), String> {
        let mut bytes = self.bytes.lock().map_err(|_| "日志缓存不可用")?;
        if let Some(file) = &self.file {
            file.clear()?;
        }
        bytes.clear();
        Ok(())
    }
    pub fn error(&self, context: &str) -> String {
        let text = self.tail();
        let tail: String = text
            .chars()
            .rev()
            .take(2400)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        if tail.trim().is_empty() {
            context.into()
        } else {
            format!("{context}\n{}", tail.trim())
        }
    }
    pub fn tail(&self) -> String {
        let Ok(bytes) = self.bytes.lock() else {
            return String::new();
        };
        let data: Vec<u8> = bytes.iter().copied().collect();
        let raw = String::from_utf8_lossy(&data);
        let text = without_ansi(&raw);
        if let Some(error) = self.file.as_ref().and_then(crate::log_files::Writer::error) {
            format!("[日志文件写入失败：{error}]\n{text}")
        } else {
            text
        }
    }
}

fn without_ansi(text: &str) -> String {
    let mut escape = false;
    let mut sequence = false;
    text.chars()
        .filter(|c| {
            if sequence {
                if ('\u{40}'..='\u{7e}').contains(c) {
                    sequence = false;
                }
                return false;
            }
            if escape {
                escape = false;
                sequence = *c == '[';
                return false;
            }
            if *c == '\u{1b}' {
                escape = true;
                return false;
            }
            !c.is_control() || matches!(c, '\n' | '\r' | '\t')
        })
        .collect()
}

#[cfg(windows)]
pub fn pipe() -> Result<(std::fs::File, std::fs::File), String> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT},
        Security::SECURITY_ATTRIBUTES,
        System::Pipes::CreatePipe,
    };
    unsafe {
        let mut read = std::ptr::null_mut();
        let mut write = std::ptr::null_mut();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        if CreatePipe(&mut read, &mut write, &attributes, 0) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let reader = std::fs::File::from_raw_handle(read);
        let writer = std::fs::File::from_raw_handle(write);
        if SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok((reader, writer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drains_past_capacity_and_keeps_the_last_error() {
        let mut output = CoreOutput::default();
        let text = format!(
            "{}\n\u{1b}[31mFATAL\u{1b}[0m listen: address already in use",
            "x".repeat(100000)
        );
        output.drain(std::io::Cursor::new(text.into_bytes()));
        output.finish();
        assert_eq!(output.bytes.lock().unwrap().len(), 16 * 1024);
        assert!(output.error("内核退出").ends_with("address already in use"));
        assert!(!output.error("内核退出").contains('\u{1b}'));
    }
}
