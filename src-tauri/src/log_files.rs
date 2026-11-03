use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const LIMIT: u64 = 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(7 * 86400);
enum Event {
    Data(Vec<u8>),
    Flush(mpsc::Sender<Result<(), String>>),
    Clear(mpsc::Sender<Result<(), String>>),
}
#[derive(Clone)]
pub struct Writer {
    sender: SyncSender<Event>,
    error: Arc<Mutex<Option<String>>>,
    dropped: Arc<AtomicUsize>,
}

fn rotated(path: &Path, index: usize) -> PathBuf {
    path.with_extension(format!("{index}.log"))
}
fn prune(path: &Path) {
    for p in std::iter::once(path.to_path_buf()).chain((1..=2).map(|i| rotated(path, i))) {
        if fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > RETENTION)
        {
            let _ = fs::remove_file(p);
        }
    }
}
fn clear(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("日志路径无效")?).map_err(|e| e.to_string())?;
    fs::write(path, []).map_err(|e| e.to_string())?;
    for i in 1..=2 {
        match fs::remove_file(rotated(path, i)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn append(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(path.parent().ok_or("日志路径无效")?).map_err(|e| e.to_string())?;
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 > LIMIT {
        let _ = fs::remove_file(rotated(path, 2));
        if rotated(path, 1).exists() {
            fs::rename(rotated(path, 1), rotated(path, 2)).map_err(|e| e.to_string())?;
        }
        if path.exists() {
            fs::rename(path, rotated(path, 1)).map_err(|e| e.to_string())?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|e| e.to_string())
}
impl Writer {
    pub fn new(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel(64);
        let error = Arc::new(Mutex::new(None));
        let errors = error.clone();
        let dropped = Arc::new(AtomicUsize::new(0));
        let skipped = dropped.clone();
        std::thread::spawn(move || {
            prune(&path);
            let mut cleaned = Instant::now();
            let mut pending = Vec::new();
            let flush = |pending: &mut Vec<u8>| {
                let missed = skipped.swap(0, Ordering::Relaxed);
                if pending.is_empty() && missed == 0 {
                    return Ok(());
                }
                if missed > 0 {
                    pending.extend_from_slice(
                        format!("\n[日志写入繁忙，略过 {missed} 个输出片段]\n").as_bytes(),
                    );
                }
                let result = append(&path, pending);
                pending.clear();
                if let Ok(mut last) = errors.lock() {
                    *last = result.as_ref().err().cloned();
                }
                result
            };
            loop {
                if cleaned.elapsed() > Duration::from_secs(3600) {
                    prune(&path);
                    cleaned = Instant::now();
                }
                let wait = if pending.is_empty() {
                    Duration::from_secs(3600)
                } else {
                    Duration::from_millis(250)
                };
                match receiver.recv_timeout(wait) {
                    Ok(Event::Data(bytes)) => {
                        pending.extend(bytes);
                        if pending.len() >= 32768 {
                            let _ = flush(&mut pending);
                        }
                    }
                    Ok(Event::Flush(reply)) => {
                        let _ = reply.send(flush(&mut pending));
                    }
                    Ok(Event::Clear(reply)) => {
                        pending.clear();
                        skipped.store(0, Ordering::Relaxed);
                        let result = clear(&path);
                        if result.is_ok() {
                            if let Ok(mut error) = errors.lock() {
                                *error = None;
                            }
                        }
                        let _ = reply.send(result);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let _ = flush(&mut pending);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = flush(&mut pending);
                        break;
                    }
                }
            }
        });
        Self {
            sender,
            error,
            dropped,
        }
    }
    pub fn write(&self, bytes: &[u8]) {
        for chunk in bytes.chunks(4096) {
            if self.sender.try_send(Event::Data(chunk.to_vec())).is_err() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    fn command(&self, clear: bool) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        self.sender
            .send(if clear {
                Event::Clear(sender)
            } else {
                Event::Flush(sender)
            })
            .map_err(|_| "日志写入线程已结束")?;
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "日志操作超时")?
    }
    pub fn flush(&self) -> Result<(), String> {
        self.command(false)
    }
    pub fn clear(&self) -> Result<(), String> {
        self.command(true)
    }
    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }
}
pub fn read_tail(path: &Path) -> Result<String, String> {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(65536)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(65536)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
pub fn clear_file(path: &Path) -> Result<(), String> {
    clear(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotates_bounds_reads_and_clears_while_writing() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".local")
            .join(format!("logs-test-{}", crate::nonce()));
        let file = root.join("core.log");
        for i in 0..5 {
            append(&file, &vec![b'a' + i; 600000]).unwrap();
        }
        assert!(file.exists() && rotated(&file, 1).exists() && rotated(&file, 2).exists());
        assert!(read_tail(&file).unwrap().len() <= 65536);
        let writer = Writer::new(file.clone());
        writer.write(b"before clear\n");
        writer.clear().unwrap();
        assert_eq!(read_tail(&file).unwrap(), "");
        writer.write(b"after clear\n");
        writer.flush().unwrap();
        assert_eq!(read_tail(&file).unwrap(), "after clear\n");
        writer.clear().unwrap();
        drop(writer);
        let old = std::time::SystemTime::now() - Duration::from_secs(8 * 86400);
        OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        prune(&file);
        assert!(!file.exists());
        fs::remove_dir(&root).unwrap();
    }
}
