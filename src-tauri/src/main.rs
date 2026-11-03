#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core_output;
mod core_updates;
mod log_files;
mod ports;
mod process_job;
mod proxy;
mod rules;
mod storage;
mod traffic;
mod tun;
mod window_shape;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Core {
    Xray,
    SingBox,
}
impl Core {
    fn name(self) -> &'static str {
        match self {
            Self::Xray => "xray",
            Self::SingBox => "sing-box",
        }
    }
    fn exe(self) -> &'static str {
        match self {
            Self::Xray => "xray.exe",
            Self::SingBox => "sing-box.exe",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreInfo {
    core: Core,
    available: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: String,
    core: Option<Core>,
    pid: Option<u32>,
    started_at: Option<String>,
    message: Option<String>,
    local_ports: Option<ports::LocalPorts>,
}
impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            state: "stopped".into(),
            core: None,
            pid: None,
            started_at: None,
            message: None,
            local_ports: None,
        }
    }
}
#[derive(Default)]
struct RuntimeState {
    last_output: String,
    elevated: Option<tun::ElevatedSession>,
    endpoint: Option<traffic::Endpoint>,
    config: Option<String>,
    starting: Option<String>,
    child: Option<Child>,
    job: Option<process_job::ProcessJob>,
    output: Option<core_output::CoreOutput>,
    config_path: Option<PathBuf>,
    status: RuntimeStatus,
}
#[derive(Default)]
struct AppState {
    app_log: Mutex<Option<log_files::Writer>>,
    runtime: Mutex<RuntimeState>,
    storage: Mutex<()>,
    rules: Mutex<()>,
    updating_rules: Mutex<bool>,
    sampler: Mutex<traffic::Sampler>,
    core_install: Mutex<()>,
    updating_cores: Mutex<bool>,
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn journal(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("system-proxy-lease.json"))
}
fn nonce() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn find_core(app: &tauri::AppHandle, core: Core) -> Result<PathBuf, String> {
    if let Some(path) = core_updates::installed(app, core) {
        return Ok(path);
    }
    bundled_core(app, core)
}

fn bundled_core(app: &tauri::AppHandle, core: Core) -> Result<PathBuf, String> {
    let mut roots = vec![];
    if let Ok(path) = app.path().resource_dir() {
        roots.push(path.join("cores").join(core.name()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("cores").join(core.name()));
        }
    }
    if cfg!(debug_assertions) {
        if let Some(project) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            roots.push(project.join("cores").join(core.name()));
            if let Ok(entries) = fs::read_dir(project) {
                for entry in entries.flatten() {
                    if entry.file_type().is_ok_and(|t| t.is_dir()) {
                        let name = entry.file_name().to_string_lossy().to_lowercase();
                        if (matches!(core, Core::Xray) && name.starts_with("xray-"))
                            || (matches!(core, Core::SingBox) && name.starts_with("sing-box-"))
                        {
                            roots.push(entry.path());
                        }
                    }
                }
            }
        }
    }
    roots
        .into_iter()
        .map(|root| root.join(core.exe()))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "未找到 {}，请将内核放入应用的 cores/{} 目录",
                core.exe(),
                core.name()
            )
        })
}

fn command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    if let Some(parent) = exe.parent() {
        cmd.current_dir(parent);
        cmd.env("XRAY_LOCATION_ASSET", parent);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.stdin(Stdio::null());
    cmd
}

fn capture(mut cmd: Command) -> Result<String, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("内核进程无法启动：{e}"))?;
    fn drain(mut reader: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut saved = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(count) = reader.read(&mut buf) {
                if count == 0 {
                    break;
                }
                let keep = count.min(65536usize.saturating_sub(saved.len()));
                saved.extend_from_slice(&buf[..keep]);
            }
            saved
        })
    }
    let out = drain(child.stdout.take().ok_or("无法读取内核输出")?);
    let err = drain(child.stderr.take().ok_or("无法读取内核错误")?);
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if start.elapsed() > Duration::from_secs(15) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out.join();
                let _ = err.join();
                return Err("内核校验超时，进程已停止".into());
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    };
    let stdout = out.join().map_err(|_| "内核输出读取失败")?;
    let stderr = err.join().map_err(|_| "内核错误读取失败")?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    if !status.success() {
        return Err(format!(
            "内核校验失败：{}",
            text.chars().take(1800).collect::<String>().trim()
        ));
    }
    Ok(text)
}

fn write_config(app: &tauri::AppHandle, config: &str, prefix: &str) -> Result<PathBuf, String> {
    if config.len() > 5 * 1024 * 1024 {
        return Err("配置不能超过 5 MB".into());
    }
    let parsed: Value = serde_json::from_str(config).map_err(|e| format!("JSON 无效：{e}"))?;
    if !parsed.is_object() {
        return Err("配置顶层必须是 JSON 对象".into());
    }
    let path = app_dir(app)?.join(format!("{prefix}-{}.json", nonce()));
    fs::write(&path, config).map_err(|e| e.to_string())?;
    Ok(path)
}
fn validate_impl(app: &tauri::AppHandle, core: Core, config: &str) -> Result<String, String> {
    let exe = find_core(app, core)?;
    let path = write_config(app, config, "validation")?;
    let mut cmd = command(&exe);
    match core {
        Core::Xray => {
            cmd.args(["run", "-test", "-c"]);
        }
        Core::SingBox => {
            cmd.args(["check", "-c"]);
        }
    }
    cmd.arg(&path);
    let result = capture(cmd);
    let _ = fs::remove_file(&path);
    result.map(|_| "内核校验通过".into())
}

#[tauri::command]
async fn discover_cores(app: tauri::AppHandle) -> Result<Vec<CoreInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        [Core::Xray, Core::SingBox]
            .into_iter()
            .map(|core| match find_core(&app, core) {
                Ok(path) => {
                    let mut cmd = command(&path);
                    cmd.arg("version");
                    match capture(cmd) {
                        Ok(version) => CoreInfo {
                            core,
                            available: true,
                            version: Some(version),
                            path: Some(path.to_string_lossy().into()),
                            error: None,
                        },
                        Err(error) => CoreInfo {
                            core,
                            available: false,
                            version: None,
                            path: Some(path.to_string_lossy().into()),
                            error: Some(error),
                        },
                    }
                }
                Err(error) => CoreInfo {
                    core,
                    available: false,
                    version: None,
                    path: None,
                    error: Some(error),
                },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn validate_config(
    app: tauri::AppHandle,
    core: Core,
    config: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || validate_impl(&app, core, &config))
        .await
        .map_err(|e| e.to_string())?
}

fn http_port(config: &str, core: Core) -> Result<u16, String> {
    let value: Value = serde_json::from_str(config).map_err(|e| e.to_string())?;
    value
        .get("inbounds")
        .and_then(Value::as_array)
        .and_then(|inbounds| {
            inbounds.iter().find_map(|inbound| {
                let (protocol_field, port_field) = match core {
                    Core::Xray => ("protocol", "port"),
                    Core::SingBox => ("type", "listen_port"),
                };
                let protocol = inbound.get(protocol_field)?.as_str()?;
                let listen = inbound.get("listen")?.as_str()?;
                if !["http", "mixed"].contains(&protocol) || listen != "127.0.0.1" {
                    return None;
                }
                // System proxy has no configured credentials. Never advertise an authenticated inbound as usable.
                if inbound
                    .get("users")
                    .and_then(Value::as_array)
                    .is_some_and(|v| !v.is_empty())
                    || inbound
                        .pointer("/settings/accounts")
                        .and_then(Value::as_array)
                        .is_some_and(|v| !v.is_empty())
                {
                    return None;
                }
                let port = inbound.get(port_field)?.as_u64()?;
                u16::try_from(port).ok().filter(|port| *port > 0)
            })
        })
        .ok_or_else(|| {
            "系统代理需要监听 127.0.0.1 的无认证 HTTP 入站；请修改原生配置或选择「仅本地代理」"
                .into()
        })
}

fn prepare_runtime(
    app: &tauri::AppHandle,
    core: Core,
    config: &str,
    managed: bool,
) -> Result<(String, Option<traffic::Endpoint>, bool), String> {
    let mut value: Value = serde_json::from_str(config).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("配置顶层必须是 JSON 对象".into());
    }
    if managed && matches!(core, Core::SingBox) {
        if let Some(entries) = value
            .pointer_mut("/route/rule_set")
            .and_then(Value::as_array_mut)
        {
            let root = rules::ensure(app)?;
            for entry in entries {
                match entry["tag"].as_str() {
                    Some("geosite-cn") => {
                        entry["path"] = root
                            .join("geosite-cn.srs")
                            .to_string_lossy()
                            .to_string()
                            .into()
                    }
                    Some("geoip-cn") => {
                        entry["path"] = root
                            .join("geoip-cn.srs")
                            .to_string_lossy()
                            .to_string()
                            .into()
                    }
                    _ => (),
                }
            }
        }
    }
    let is_tun = tun::has_tun(&value, core);
    if managed && is_tun {
        tun::unique_interface(&mut value, core)?;
    }
    let endpoint = if managed {
        Some(traffic::instrument(&mut value, core)?)
    } else {
        traffic::detect(&value, core)
    };
    Ok((
        if managed {
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
        } else {
            config.into()
        },
        endpoint,
        is_tun,
    ))
}

fn stop_impl(app: &tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let (mut child, mut elevated, job, path, mut output) = {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
        runtime.starting = None;
        runtime.status = RuntimeStatus::default();
        runtime.endpoint = None;
        runtime.config = None;
        (
            runtime.child.take(),
            runtime.elevated.take(),
            runtime.job.take(),
            runtime.config_path.take(),
            runtime.output.take(),
        )
    };
    let mut last_output = elevated.as_mut().and_then(|peer| peer.logs().ok());
    let result = if let Some(peer) = elevated.as_mut() {
        peer.stop()
    } else {
        Ok(())
    };
    if let Some(child) = child.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            child.kill().map_err(|e| e.to_string())?;
        }
        let _ = child.wait();
    }
    drop(job);
    if let Some(output) = output.as_mut() {
        output.finish();
        last_output = Some(output.tail());
    }
    if let Some(log) = last_output.filter(|log| !log.is_empty()) {
        if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
            runtime.last_output = log;
        }
    }
    drop(elevated);
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
    proxy::restore(&journal(app)?)?;
    app.state::<AppState>()
        .sampler
        .lock()
        .map_err(|_| "统计不可用")?
        .previous = None;
    let logger = app
        .state::<AppState>()
        .app_log
        .lock()
        .map_err(|_| "日志不可用")?
        .clone();
    if let Some(logger) = logger {
        let _ = logger.flush();
    }
    result?;
    Ok(RuntimeStatus::default())
}

#[tauri::command]
async fn start_core(
    app: tauri::AppHandle,
    core: Core,
    config: String,
    mode: String,
    managed: Option<bool>,
) -> Result<RuntimeStatus, String> {
    let feedback = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _install = state.core_install.lock().map_err(|_| "内核更新不可用")?;
        if !["local", "system", "tun"].contains(&mode.as_str()) {
            return Err("连接方式无效".into());
        }
        let managed = managed.unwrap_or(false);
        let mut value: Value = serde_json::from_str(&config).map_err(|e| e.to_string())?;
        let mut reservation = if managed {
            Some(ports::prepare(&mut value, core)?)
        } else {
            None
        };
        let local_ports = reservation.as_ref().map(|r| r.ports);
        let port_message = reservation.as_ref().filter(|r| r.changed).map(|r| {
            format!(
                "端口被占用，已切换为 SOCKS {} / HTTP {}",
                r.ports.socks, r.ports.http
            )
        });
        let input = if managed {
            serde_json::to_string(&value).map_err(|e| e.to_string())?
        } else {
            config
        };
        let (config, endpoint, is_tun) = prepare_runtime(&app, core, &input, managed)?;
        if mode == "tun" && !is_tun {
            return Err("原生配置中需要定义 TUN 入站".into());
        }
        let port = if mode == "system" && !is_tun {
            Some(http_port(&config, core)?)
        } else {
            None
        };
        validate_impl(&app, core, &config)?;
        let operation = nonce();
        {
            let state = app.state::<AppState>();
            let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
            if runtime.child.is_some() || runtime.elevated.is_some() || runtime.starting.is_some() {
                return Err("请先断开当前连接".into());
            }
            runtime.starting = Some(operation.clone());
            runtime.last_output.clear();
        }
        struct StartGuard {
            app: tauri::AppHandle,
            id: String,
        }
        impl Drop for StartGuard {
            fn drop(&mut self) {
                if let Ok(mut state) = self.app.state::<AppState>().runtime.lock() {
                    if state.starting.as_ref() == Some(&self.id) {
                        state.starting = None;
                    }
                }
            }
        }
        let _guard = StartGuard {
            app: app.clone(),
            id: operation.clone(),
        };
        let (child, elevated, job, path, pid, output) = if is_tun {
            let peer = tun::start(&app, core, config.clone(), managed, &mut reservation)?;
            let pid = peer.pid;
            (None, Some(peer), None, None, pid, None)
        } else {
            let exe = find_core(&app, core)?;
            let path = write_config(&app, &config, "runtime")?;
            let log_path = app_dir(&app)?.join("logs/core.log");
            let mut cmd = command(&exe);
            if matches!(core, Core::SingBox) {
                cmd.arg("--disable-color");
            }
            cmd.args(["run", "-c"])
                .arg(&path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            drop(reservation.take());
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    return Err(error.to_string());
                }
            };
            let mut output = core_output::CoreOutput::default();
            output.enable_file(log_path);
            if let Some(stdout) = child.stdout.take() {
                output.drain(stdout);
            }
            if let Some(stderr) = child.stderr.take() {
                output.drain(stderr);
            }
            let job = match process_job::ProcessJob::attach(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            };
            thread::sleep(Duration::from_millis(450));
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                output.finish();
                let _ = fs::remove_file(&path);
                return Err(output.error(&format!("{} 内核退出：{status}", core.name())));
            }
            if let Some(port) = port {
                let ready = (0..20).any(|_| {
                    if TcpStream::connect_timeout(
                        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
                        Duration::from_millis(100),
                    )
                    .is_ok()
                    {
                        true
                    } else {
                        thread::sleep(Duration::from_millis(75));
                        false
                    }
                });
                let result = if ready {
                    proxy::apply(&journal(&app)?, port)
                } else {
                    Err("HTTP 入站未就绪".into())
                };
                if let Err(error) = result {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
            }
            let pid = child.id();
            (Some(child), None, Some(job), Some(path), pid, Some(output))
        };
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
        if runtime.starting.as_ref() != Some(&operation) {
            drop(elevated);
            drop(job);
            if let Some(path) = path {
                let _ = fs::remove_file(path);
            }
            let _ = proxy::restore(&journal(&app)?);
            return Err("连接已取消".into());
        }
        runtime.starting = None;
        runtime.child = child;
        runtime.elevated = elevated;
        runtime.job = job;
        runtime.output = output;
        runtime.config_path = path;
        runtime.config = Some(config);
        runtime.endpoint = endpoint;
        runtime.status = RuntimeStatus {
            state: "running".into(),
            core: Some(core),
            pid: Some(pid),
            started_at: Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .to_string(),
            ),
            message: port_message,
            local_ports,
        };
        Ok(runtime.status.clone())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(error) = &result {
        if let Ok(mut runtime) = feedback.state::<AppState>().runtime.lock() {
            if runtime.child.is_none() && runtime.elevated.is_none() && runtime.starting.is_none() {
                runtime.last_output = error.clone();
                runtime.status = RuntimeStatus {
                    state: "error".into(),
                    message: Some(error.clone()),
                    ..RuntimeStatus::default()
                };
            }
        }
    }
    result
}
#[tauri::command]
async fn stop_core(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || stop_impl(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn runtime_status(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let error = {
            let state = app.state::<AppState>();
            let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
            if let Some(peer) = runtime.elevated.as_mut() {
                match peer.status() {
                    Ok(status) if status.running => None,
                    Ok(status) => Some(status.message.unwrap_or("TUN 内核已退出".into())),
                    Err(error) => Some(error),
                }
            } else if let Some(child) = runtime.child.as_mut() {
                let exit = child.try_wait().map_err(|e| e.to_string())?;
                exit.map(|status| {
                    let context = format!("内核已退出：{status}");
                    if let Some(output) = runtime.output.as_mut() {
                        output.finish();
                        output.error(&context)
                    } else {
                        context
                    }
                })
            } else {
                None
            }
        };
        if let Some(error) = error {
            let restore_error = stop_impl(&app).err();
            let state = app.state::<AppState>();
            let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
            runtime.status = RuntimeStatus {
                state: "error".into(),
                message: Some(format!(
                    "{error}{}",
                    restore_error.map(|e| format!("；{e}")).unwrap_or_default()
                )),
                ..RuntimeStatus::default()
            };
        }
        let state = app.state::<AppState>();
        let result = state
            .runtime
            .lock()
            .map_err(|_| "运行状态不可用")?
            .status
            .clone();
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn traffic_stats(app: tauri::AppHandle) -> Result<traffic::TrafficStats, String> {
    let target = {
        let state = app.state::<AppState>();
        let runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
        runtime.endpoint.clone().zip(runtime.status.pid)
    };
    let Some((endpoint, pid)) = target else {
        return Ok(traffic::TrafficStats::default());
    };
    let Ok((upload, download)) = traffic::totals(&endpoint).await else {
        return Ok(traffic::TrafficStats::default());
    };
    let state = app.state::<AppState>();
    if state
        .runtime
        .lock()
        .map_err(|_| "运行状态不可用")?
        .status
        .pid
        != Some(pid)
    {
        return Ok(traffic::TrafficStats::default());
    }
    let result = state
        .sampler
        .lock()
        .map_err(|_| "统计不可用")?
        .sample(pid, upload, download);
    Ok(result)
}
#[tauri::command]
async fn rules_status(app: tauri::AppHandle) -> Result<rules::RuleStatus, String> {
    tauri::async_runtime::spawn_blocking(move || rules::status(&app))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn update_rules(app: tauri::AppHandle, force: bool) -> Result<rules::RuleStatus, String> {
    rules::update(app, force).await
}
#[tauri::command]
async fn runtime_logs(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
        let log = if let Some(peer) = runtime.elevated.as_mut() {
            peer.logs().ok()
        } else {
            runtime.output.as_ref().map(core_output::CoreOutput::tail)
        };
        if let Some(log) = log {
            runtime.last_output = log;
        }
        if runtime.last_output.is_empty() {
            log_files::read_tail(&app_dir(&app)?.join("logs/core.log"))
        } else {
            Ok(runtime.last_output.clone())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn append_app_log(app: tauri::AppHandle, entry: String) -> Result<(), String> {
    if entry.len() > 16384 {
        return Err("日志条目过长".into());
    }
    let path = app_dir(&app)?.join("logs/app.log");
    let state = app.state::<AppState>();
    let mut logger = state.app_log.lock().map_err(|_| "日志不可用")?;
    let writer = logger.get_or_insert_with(|| log_files::Writer::new(path));
    writer.write(format!("{entry}\n").as_bytes());
    Ok(())
}
#[tauri::command]
async fn app_logs(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let writer = app
            .state::<AppState>()
            .app_log
            .lock()
            .map_err(|_| "日志不可用")?
            .clone();
        if let Some(writer) = writer {
            writer.flush()?;
        }
        log_files::read_tail(&app_dir(&app)?.join("logs/app.log"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn clear_logs(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        match kind.as_str() {
            "app" => {
                let writer = state.app_log.lock().map_err(|_| "日志不可用")?.clone();
                if let Some(writer) = writer {
                    writer.clear()
                } else {
                    log_files::clear_file(&app_dir(&app)?.join("logs/app.log"))
                }
            }
            "core" => {
                let mut runtime = state.runtime.lock().map_err(|_| "运行状态不可用")?;
                if let Some(peer) = runtime.elevated.as_mut() {
                    peer.clear_logs()?;
                } else if let Some(output) = runtime.output.as_mut() {
                    output.clear()?;
                } else {
                    log_files::clear_file(&app_dir(&app)?.join("logs/core.log"))?;
                }
                runtime.last_output.clear();
                Ok(())
            }
            _ => Err("日志类型无效".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn current_config(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let value = state
            .runtime
            .lock()
            .map_err(|_| "运行状态不可用")?
            .config
            .clone();
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_subscription(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "订阅地址无效")?;
    if !["http", "https"].contains(&parsed.scheme())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("仅支持 HTTP / HTTPS 订阅地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("重定向过多");
            }
            if attempt.previous().iter().any(|url| url.scheme() == "https")
                && attempt.url().scheme() != "https"
            {
                return attempt.error("拒绝 HTTPS 降级");
            }
            attempt.follow()
        }))
        .user_agent("Anibox/0.1.0")
        .build()
        .map_err(|_| "无法创建订阅请求")?;
    // No URL is included in errors: query strings commonly contain subscription credentials.
    let mut response = client
        .get(parsed)
        .send()
        .await
        .map_err(|_| "订阅请求失败，请检查网络与地址")?;
    if !response.status().is_success() {
        return Err(format!(
            "订阅服务器返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let limit = 5 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("订阅内容超过 5 MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取订阅失败")? {
        if bytes.len() + chunk.len() > limit {
            return Err("订阅内容超过 5 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "订阅内容不是 UTF-8 文本".into())
}

#[tauri::command]
fn set_close_behavior(behavior: String) -> Result<(), String> {
    if !["ask", "tray", "exit"].contains(&behavior.as_str()) {
        return Err("关闭行为无效".into());
    }
    Ok(()) // The frontend owns the decision so it can protect unsaved editor changes.
}
#[tauri::command]
async fn close_app(app: tauri::AppHandle, action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "tray" => app
            .get_webview_window("main")
            .ok_or("主窗口不存在")?
            .hide()
            .map_err(|e| e.to_string()),
        "exit" => {
            stop_impl(&app)?;
            app.exit(0);
            Ok(())
        }
        _ => Err("关闭行为无效".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--tun-helper") {
        let result = std::env::args_os()
            .nth(2)
            .map(PathBuf::from)
            .ok_or("缺少 TUN 请求".to_string())
            .and_then(tun::helper_main);
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window_shape::install(&window.as_ref().window()).map_err(std::io::Error::other)?;
            }
            let _ = rules::ensure(app.handle());
            proxy::restore(&journal(app.handle()).map_err(std::io::Error::other)?)
                .map_err(std::io::Error::other)?;
            let show = MenuItem::with_id(app, "show", "打开 Anibox", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Anibox", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut rgba = vec![0u8; 32 * 32 * 4];
            for y in 0..32 {
                for x in 0..32 {
                    let offset = (y * 32 + x) * 4;
                    let inside = (x as i32 - 16).pow(2) + (y as i32 - 16).pow(2) < 220;
                    let plane = y > 6 && y < 26 && (x as i32 - 16).abs() < (y as i32 - 5) / 2;
                    let color = if plane {
                        [185, 229, 255, 255]
                    } else if inside {
                        [37, 55, 68, 255]
                    } else {
                        [0, 0, 0, 0]
                    };
                    rgba[offset..offset + 4].copy_from_slice(&color);
                }
            }
            TrayIconBuilder::new()
                .icon(tauri::image::Image::new_owned(rgba, 32, 32))
                .tooltip("Anibox")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        let _ = app.emit("exit-requested", ());
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
                    | tauri::WindowEvent::Focused(_)
            ) {
                window_shape::apply(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            discover_cores,
            validate_config,
            start_core,
            stop_core,
            runtime_status,
            fetch_subscription,
            storage::load_data,
            storage::save_data,
            storage::storage_info,
            storage::store_background,
            storage::load_background,
            storage::reset_backgrounds,
            storage::export_data,
            storage::choose_storage_directory,
            storage::set_storage_directory,
            storage::open_storage_folder,
            set_close_behavior,
            close_app,
            traffic_stats,
            rules_status,
            update_rules,
            current_config,
            runtime_logs,
            append_app_log,
            app_logs,
            clear_logs,
            core_updates::check_core_updates,
            core_updates::install_core_update,
            core_updates::rollback_core
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 Anibox");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let _ = stop_impl(app);
        }
    });
}
