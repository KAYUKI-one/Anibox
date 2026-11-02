//! A single-purpose elevated process. Authenticated loopback IPC closes when the GUI exits.
//! The helper owns its console process, gives it Ctrl+Break on stop, and only cleans its own interface.
use crate::Core;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    endpoint: String,
    core: Core,
    config: String,
    managed: bool,
}
#[derive(Serialize, Deserialize)]
struct Response {
    state: String,
    pid: Option<u32>,
    message: Option<String>,
}
pub struct ElevatedSession {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    pub pid: u32,
}
impl ElevatedSession {
    fn exchange(&mut self, command: &str) -> Result<Response, String> {
        self.stream
            .write_all(format!("{command}\n").as_bytes())
            .map_err(|_| "TUN 进程连接已关闭")?;
        let mut line = String::new();
        if self
            .reader
            .read_line(&mut line)
            .map_err(|_| "TUN 进程响应超时")?
            == 0
        {
            return Err("TUN 进程已退出".into());
        }
        serde_json::from_str(&line).map_err(|_| "TUN 进程响应无效".into())
    }
    pub fn status(&mut self) -> Result<ResponseStatus, String> {
        let response = self.exchange("status")?;
        Ok(ResponseStatus {
            running: response.state == "running",
            message: response.message,
        })
    }
    pub fn stop(&mut self) -> Result<(), String> {
        self.stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        let response = self.exchange("stop")?;
        if response.state == "error" {
            Err(response.message.unwrap_or("TUN 停止失败".into()))
        } else {
            Ok(())
        }
    }
}
pub struct ResponseStatus {
    pub running: bool,
    pub message: Option<String>,
}
impl Drop for ElevatedSession {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

pub fn random_token() -> Result<String, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut bytes = [0u8; 32];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err("无法生成进程认证令牌".into());
        }
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    #[cfg(not(windows))]
    {
        Err("TUN 目前仅支持 Windows".into())
    }
}

pub fn has_tun(value: &serde_json::Value, core: Core) -> bool {
    value
        .get("inbounds")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|list| {
            list.iter().any(|inbound| {
                inbound[match core {
                    Core::Xray => "protocol",
                    Core::SingBox => "type",
                }]
                .as_str()
                    == Some("tun")
            })
        })
}
pub fn unique_interface(value: &mut serde_json::Value, core: Core) -> Result<(), String> {
    let name = format!("Anibox-{}", &random_token()?[..8]);
    if let Some(list) = value["inbounds"].as_array_mut() {
        for inbound in list {
            if inbound[match core {
                Core::Xray => "protocol",
                Core::SingBox => "type",
            }]
            .as_str()
                == Some("tun")
            {
                match core {
                    Core::Xray => inbound["settings"]["name"] = name.clone().into(),
                    Core::SingBox => inbound["interface_name"] = name.clone().into(),
                }
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn start(
    app: &tauri::AppHandle,
    core: Core,
    config: String,
    managed: bool,
) -> Result<ElevatedSession, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::WaitForSingleObject,
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    };
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let token = random_token()?;
    let path = crate::app_dir(app)?.join(format!("tun-request-{}.json", &token[..16]));
    let request = Request {
        token: token.clone(),
        endpoint: listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string(),
        core,
        config,
        managed,
    };
    fs::write(
        &path,
        serde_json::to_vec(&request).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let file = wide(exe.as_os_str());
    let verb = wide(std::ffi::OsStr::new("runas"));
    let parameters = wide(std::ffi::OsStr::new(&format!(
        "--tun-helper \"{}\"",
        path.display()
    )));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of_val(&info) as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = std::io::Error::last_os_error();
        let _ = fs::remove_file(&path);
        return Err(if error.raw_os_error() == Some(1223) {
            "已取消 TUN 管理员授权".into()
        } else {
            format!("无法启动 TUN 提权进程：{error}")
        });
    }
    struct Handle(isize);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as _);
            }
        }
    }
    let handle = Handle(info.hProcess as isize);
    let started = Instant::now();
    let result = loop {
        if started.elapsed() > Duration::from_secs(90) {
            break Err("TUN 启动超时".into());
        }
        if unsafe { WaitForSingleObject(handle.0 as _, 0) } == WAIT_OBJECT_0 {
            break Err("TUN 提权进程未能启动，请检查管理员权限".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_secs(35)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .map_err(|e| e.to_string())?;
                let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
                let mut hello = String::new();
                if reader.read_line(&mut hello).is_err() || hello.trim() != token {
                    continue;
                }
                stream.write_all(b"OK\n").map_err(|e| e.to_string())?;
                let mut reply = String::new();
                reader.read_line(&mut reply).map_err(|_| "TUN 启动未响应")?;
                let response: Response =
                    serde_json::from_str(&reply).map_err(|_| "TUN 启动响应无效")?;
                if response.state != "running" {
                    break Err(response.message.unwrap_or("TUN 启动失败".into()));
                }
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .map_err(|e| e.to_string())?;
                break Ok(ElevatedSession {
                    stream,
                    reader,
                    pid: response.pid.ok_or("TUN 未返回进程标识")?,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(e) => break Err(e.to_string()),
        }
    };
    let _ = fs::remove_file(path);
    result
}
#[cfg(not(windows))]
pub fn start(_: &tauri::AppHandle, _: Core, _: String, _: bool) -> Result<ElevatedSession, String> {
    Err("TUN 目前仅支持 Windows".into())
}

#[cfg(windows)]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
struct ConsoleCore {
    handle: isize,
    pid: u32,
    _job: crate::process_job::ProcessJob,
    owned_interface: Option<String>,
    lease: Option<PathBuf>,
}
#[cfg(windows)]
impl ConsoleCore {
    fn spawn(
        exe: &Path,
        config_path: &Path,
        interface: Option<String>,
        lease: Option<PathBuf>,
    ) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
        let file = wide(exe.as_os_str());
        let mut args = wide(std::ffi::OsStr::new(&format!(
            "\"{}\" run -c \"{}\"",
            exe.display(),
            config_path.display()
        )));
        let cwd = wide(exe.parent().ok_or("内核路径无效")?.as_os_str());
        let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of_val(&startup) as u32;
        startup.dwFlags = 1;
        startup.wShowWindow = 0;
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            CreateProcessW(
                file.as_ptr(),
                args.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NEW_CONSOLE,
                std::ptr::null(),
                cwd.as_ptr(),
                &startup,
                &mut process,
            )
        } == 0
        {
            return Err(format!(
                "TUN 内核启动失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        unsafe {
            CloseHandle(process.hThread);
        }
        let job = match crate::process_job::ProcessJob::attach_handle(process.hProcess) {
            Ok(job) => job,
            Err(e) => {
                unsafe {
                    TerminateProcess(process.hProcess, 1);
                    CloseHandle(process.hProcess);
                }
                return Err(e);
            }
        };
        let instance = Self {
            handle: process.hProcess as isize,
            pid: process.dwProcessId,
            _job: job,
            owned_interface: interface,
            lease,
        };
        std::thread::sleep(Duration::from_millis(900));
        if !instance.running() {
            return Err("TUN 内核退出，请检查配置、端口或虚拟网卡驱动".into());
        }
        Ok(instance)
    }
    fn running(&self) -> bool {
        unsafe {
            windows_sys::Win32::System::Threading::WaitForSingleObject(self.handle as _, 0)
                == windows_sys::Win32::Foundation::WAIT_TIMEOUT
        }
    }
    fn stop(&mut self) -> Result<(), String> {
        use windows_sys::Win32::{
            Foundation::WAIT_TIMEOUT,
            System::{Console::*, Threading::*},
        };
        if self.running() {
            unsafe {
                unsafe extern "system" fn ignore_helper_signal(_: u32) -> i32 {
                    1
                }
                FreeConsole();
                if AttachConsole(self.pid) != 0 {
                    SetConsoleCtrlHandler(Some(ignore_helper_signal), 1);
                    // A newly allocated console ignores CREATE_NEW_PROCESS_GROUP. Signal this
                    // private console, while the helper's own handler explicitly ignores it.
                    GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, 0);
                    WaitForSingleObject(self.handle as _, 5000);
                    FreeConsole();
                }
                if WaitForSingleObject(self.handle as _, 0) == WAIT_TIMEOUT {
                    TerminateProcess(self.handle as _, 1);
                    WaitForSingleObject(self.handle as _, 2000);
                }
            }
        }
        if let Some(alias) = self.owned_interface.take() {
            if let Err(error) = cleanup_routes(&alias) {
                self.owned_interface = Some(alias);
                return Err(error);
            }
        }
        if let Some(path) = self.lease.take() {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for ConsoleCore {
    fn drop(&mut self) {
        let _ = self.stop();
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

fn owned_alias(value: &serde_json::Value, core: Core) -> Option<String> {
    value["inbounds"].as_array()?.iter().find_map(|inbound| {
        let alias = match core {
            Core::Xray => inbound.pointer("/settings/name"),
            Core::SingBox => inbound.get("interface_name"),
        }?
        .as_str()?;
        let suffix = alias.strip_prefix("Anibox-")?;
        (suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| alias.to_string())
    })
}
#[cfg(windows)]
fn cleanup_routes(alias: &str) -> Result<(), String> {
    if !alias
        .strip_prefix("Anibox-")
        .is_some_and(|s| s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("TUN 接口标识无效".into());
    }
    use std::os::windows::process::CommandExt;
    let script=format!("$ErrorActionPreference='Stop';$i=Get-NetAdapter -IncludeHidden -Name '{alias}' -ErrorAction SilentlyContinue;if($i){{Get-NetRoute -InterfaceIndex $i.ifIndex -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false;Set-DnsClientServerAddress -InterfaceIndex $i.ifIndex -ResetServerAddresses}} ");
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("TUN 路由清理失败，将在下次启用 TUN 时重试".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn helper_main(path: PathBuf) -> Result<(), String> {
    if unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() } == 0 {
        return Err("TUN 需要管理员权限".into());
    }
    // Only accept requests from this application's per-user data directory, never arbitrary config paths.
    let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("无法定位数据目录")?)
        .join(env!("ANIBOX_APP_ID"));
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if canonical.parent() != Some(root.as_path())
        || !canonical
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("tun-request-"))
    {
        return Err("TUN 请求路径无效".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if metadata.len() > 6 * 1024 * 1024 {
        return Err("TUN 请求过大".into());
    }
    let request: Request =
        serde_json::from_slice(&fs::read(&canonical).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    fs::remove_file(&canonical).map_err(|e| e.to_string())?;
    let address: std::net::SocketAddr = request.endpoint.parse().map_err(|_| "TUN 控制地址无效")?;
    if !address.ip().is_loopback()
        || request.token.len() != 64
        || !request.token.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("TUN 认证参数无效".into());
    }
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    stream
        .write_all(format!("{}\n", request.token).as_bytes())
        .map_err(|e| e.to_string())?;
    let mut ack = String::new();
    reader.read_line(&mut ack).map_err(|e| e.to_string())?;
    if ack.trim() != "OK" {
        return Err("TUN 控制端认证失败".into());
    }
    let result = run_helper(&request, &root, &mut stream, &mut reader);
    if let Err(error) = &result {
        let _ = write_response(
            &mut stream,
            Response {
                state: "error".into(),
                pid: None,
                message: Some(error.clone()),
            },
        );
    }
    result
}
#[cfg(windows)]
fn run_helper(
    request: &Request,
    root: &Path,
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
) -> Result<(), String> {
    // Recover only our recorded generated interface names after an interrupted previous helper.
    for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("tun-lease-")
        {
            if let Ok(alias) = fs::read_to_string(entry.path()) {
                cleanup_routes(alias.trim())?;
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let value: serde_json::Value =
        serde_json::from_str(&request.config).map_err(|e| e.to_string())?;
    if !has_tun(&value, request.core) {
        return Err("原生配置中没有 TUN 入站".into());
    }
    let exe = helper_core_path(request.core)?;
    let path = root.join(format!("tun-runtime-{}.json", &request.token[..16]));
    fs::write(&path, &request.config).map_err(|e| e.to_string())?;
    struct RemoveFile(PathBuf);
    impl Drop for RemoveFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _config_guard = RemoveFile(path.clone());
    let mut check = crate::command(&exe);
    match request.core {
        Core::Xray => {
            check.args(["run", "-test", "-c"]);
        }
        Core::SingBox => {
            check.args(["check", "-c"]);
        }
    }
    check.arg(&path);
    crate::capture(check)?;
    let alias = if request.managed {
        owned_alias(&value, request.core)
    } else {
        None
    };
    let lease = alias
        .as_ref()
        .map(|alias| root.join(format!("tun-lease-{}.txt", alias)));
    if let (Some(alias), Some(lease)) = (&alias, &lease) {
        fs::write(lease, alias).map_err(|e| e.to_string())?;
    }
    let mut child = ConsoleCore::spawn(&exe, &path, alias, lease)?;
    write_response(
        stream,
        Response {
            state: "running".into(),
            pid: Some(child.pid),
            message: None,
        },
    )?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.trim() == "stop" => {
                child.stop()?;
                write_response(
                    stream,
                    Response {
                        state: "stopped".into(),
                        pid: None,
                        message: None,
                    },
                )?;
                break;
            }
            Ok(_) if line.trim() == "status" => {
                let running = child.running();
                write_response(
                    stream,
                    Response {
                        state: if running { "running" } else { "error" }.into(),
                        pid: Some(child.pid),
                        message: (!running).then(|| "TUN 内核已退出".into()),
                    },
                )?;
                if !running {
                    break;
                }
            }
            Ok(_) => return Err("TUN 控制命令无效".into()),
            Err(e)
                if [std::io::ErrorKind::WouldBlock, std::io::ErrorKind::TimedOut]
                    .contains(&e.kind()) =>
            {
                if !child.running() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    child.stop()
}
fn write_response(stream: &mut TcpStream, response: Response) -> Result<(), String> {
    let mut text = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    text.push(b'\n');
    stream.write_all(&text).map_err(|e| e.to_string())
}
#[cfg(windows)]
fn helper_core_path(core: Core) -> Result<PathBuf, String> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local).join(env!("ANIBOX_APP_ID"));
        if let Some(path) = crate::core_updates::installed_in(&root, core) {
            return Ok(path);
        }
    }
    let own = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = own
        .parent()
        .ok_or("程序路径无效")?
        .join("cores")
        .join(core.name())
        .join(core.exe());
    if path.is_file() {
        return Ok(path);
    }
    if cfg!(debug_assertions) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("项目路径无效")?;
        for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with(&format!("{}-", core.name()))
                && entry.path().join(core.exe()).is_file()
            {
                return Ok(entry.path().join(core.exe()));
            }
        }
    }
    Err("TUN 提权进程找不到内核".into())
}
#[cfg(not(windows))]
pub fn helper_main(_: PathBuf) -> Result<(), String> {
    Err("TUN 仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn generated_aliases_are_isolated_and_native_names_are_not_owned() {
        let mut value = json!({"inbounds":[{"protocol":"tun","settings":{"name":"UserAdapter"}}]});
        assert!(owned_alias(&value, Core::Xray).is_none());
        unique_interface(&mut value, Core::Xray).unwrap();
        assert!(owned_alias(&value, Core::Xray).is_some());
        assert!(has_tun(&value, Core::Xray));
    }

    #[cfg(windows)]
    #[test]
    fn hidden_console_core_exits_gracefully() {
        use std::os::windows::process::CommandExt;
        if std::env::var("ANIBOX_CONSOLE_TEST_CHILD").as_deref() != Ok("1") {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tun::tests::hidden_console_core_exits_gracefully",
                    "--nocapture",
                ])
                .env("ANIBOX_CONSOLE_TEST_CHILD", "1")
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        for core in [Core::Xray, Core::SingBox] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let path = root.join(".local").join(format!(
                "console-check-{}-{}.json",
                core.name(),
                std::process::id()
            ));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let config = match core {
                Core::Xray => {
                    json!({"inbounds":[{"protocol":"http","listen":"127.0.0.1","port":port}],"outbounds":[{"protocol":"freedom"}]})
                }
                Core::SingBox => {
                    json!({"inbounds":[{"type":"http","listen":"127.0.0.1","listen_port":port}],"outbounds":[{"type":"direct","tag":"direct"}]})
                }
            };
            fs::write(&path, config.to_string()).unwrap();
            let mut child =
                ConsoleCore::spawn(&helper_core_path(core).unwrap(), &path, None, None).unwrap();
            assert!(child.running());
            child.stop().unwrap();
            let mut code = 0;
            unsafe {
                windows_sys::Win32::System::Threading::GetExitCodeProcess(
                    child.handle as _,
                    &mut code,
                );
            }
            assert_eq!(code, 0, "{} should exit gracefully", core.name());
            drop(child);
            fs::remove_file(path).unwrap();
        }
    }
}
