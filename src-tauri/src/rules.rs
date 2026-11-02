use crate::{app_dir, capture, command, find_core, AppState, Core};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const RESOURCES: [(&str, &str); 2] = [
    (
        "geosite-cn.srs",
        "https://raw.githubusercontent.com/2dust/sing-box-rules/rule-set-geosite/geosite-cn.srs",
    ),
    (
        "geoip-cn.srs",
        "https://raw.githubusercontent.com/2dust/sing-box-rules/rule-set-geoip/geoip-cn.srs",
    ),
];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleStatus {
    pub ready: bool,
    pub updated_at: Option<u64>,
    pub source: String,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    generation: String,
    updated: u64,
    checked: u64,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn read_manifest(root: &Path) -> Option<Manifest> {
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(root.join("current.json")).ok()?).ok()?;
    if manifest.generation != "bundled" && !manifest.generation.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some(manifest)
}
fn write_manifest(root: &Path, manifest: &Manifest) -> Result<(), String> {
    let temporary = root.join("current.next.json");
    fs::write(
        &temporary,
        serde_json::to_vec(manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let destination = root.join("current.json");
    if let Err(error) = fs::rename(&temporary, &destination) {
        if error.raw_os_error() != Some(17) {
            return Err(error.to_string());
        }
        fs::copy(&temporary, &destination).map_err(|e| e.to_string())?;
        fs::remove_file(temporary).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn seed_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = vec![];
    if let Ok(root) = app.path().resource_dir() {
        candidates.push(root.join("rules/seed"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent() {
            candidates.push(root.join("rules/seed"));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/rules"));
    }
    candidates
        .into_iter()
        .find(|path| RESOURCES.iter().all(|(name, _)| path.join(name).is_file()))
}

pub fn ensure(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let _guard = state.rules.lock().map_err(|_| "规则存储不可用")?;
    let root = app_dir(app)?.join("rules");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if let Some(manifest) = read_manifest(&root) {
        let generation = root.join(manifest.generation);
        if RESOURCES
            .iter()
            .all(|(name, _)| generation.join(name).is_file())
        {
            return Ok(generation);
        }
    }
    let seed = seed_path(app).ok_or("缺少规则资源，请在设置中更新规则")?;
    let generation = root.join("bundled");
    fs::create_dir_all(&generation).map_err(|e| e.to_string())?;
    for (name, _) in RESOURCES {
        fs::copy(seed.join(name), generation.join(name)).map_err(|e| e.to_string())?;
    }
    write_manifest(
        &root,
        &Manifest {
            generation: "bundled".into(),
            updated: now(),
            checked: 0,
        },
    )?;
    Ok(generation)
}

pub fn status(app: &tauri::AppHandle) -> Result<RuleStatus, String> {
    let ready = ensure(app).is_ok();
    let root = app_dir(app)?.join("rules");
    Ok(RuleStatus {
        ready,
        updated_at: read_manifest(&root).map(|m| m.updated),
        source: "2dust/sing-box-rules".into(),
    })
}

pub async fn update(app: tauri::AppHandle, force: bool) -> Result<RuleStatus, String> {
    let preparation = app.clone();
    let (root, current, cached) = tauri::async_runtime::spawn_blocking(move || {
        let current = ensure(&preparation).ok();
        let root = app_dir(&preparation)?.join("rules");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let cached = if !force
            && read_manifest(&root).is_some_and(|m| now().saturating_sub(m.checked) < 86400000)
        {
            Some(status(&preparation)?)
        } else {
            None
        };
        Ok::<_, String>((root, current, cached))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(cached) = cached {
        return Ok(cached);
    }
    {
        let state = app.state::<AppState>();
        let mut updating = state.updating_rules.lock().map_err(|_| "规则更新不可用")?;
        if *updating {
            return status(&app);
        }
        *updating = true;
    }
    let _updating = UpdatingGuard(app.clone());
    update_inner(app, root, current).await
}

struct UpdatingGuard(tauri::AppHandle);
impl Drop for UpdatingGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.state::<AppState>().updating_rules.lock() {
            *guard = false;
        }
    }
}
async fn update_inner(
    app: tauri::AppHandle,
    root: PathBuf,
    current: Option<PathBuf>,
) -> Result<RuleStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent(concat!("Anibox/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let mut payloads = vec![];
    for (name, url) in RESOURCES {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "规则下载失败，继续使用已缓存规则")?
            .error_for_status()
            .map_err(|_| "规则服务器返回错误，继续使用已缓存规则")?;
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "规则下载中断")? {
            if data.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("规则资源大小异常".into());
            }
            data.extend_from_slice(&chunk);
        }
        if !data.starts_with(b"SRS") {
            return Err("下载内容不是 SRS 规则，已保留原规则".into());
        }
        payloads.push((name, data));
    }
    // Native validation launches a process and waits for it. Keep it and the
    // filesystem transaction off both the UI thread and async runtime workers.
    tauri::async_runtime::spawn_blocking(move || install(&app, &root, current, payloads))
        .await
        .map_err(|e| e.to_string())?
}

fn install(
    app: &tauri::AppHandle,
    root: &Path,
    current: Option<PathBuf>,
    payloads: Vec<(&str, Vec<u8>)>,
) -> Result<RuleStatus, String> {
    if let Some(current) = current {
        if payloads
            .iter()
            .all(|(name, data)| fs::read(current.join(name)).is_ok_and(|old| old == *data))
        {
            let mut manifest = read_manifest(root).ok_or("规则索引无效")?;
            manifest.checked = now();
            write_manifest(root, &manifest)?;
            return status(app);
        }
    }
    let generation_name = now().to_string();
    let generation = root.join(&generation_name);
    fs::create_dir_all(&generation).map_err(|e| e.to_string())?;
    for (name, data) in payloads {
        fs::write(generation.join(name), data).map_err(|e| e.to_string())?;
    }
    let validation = serde_json::json!({"outbounds":[{"type":"direct","tag":"direct"}],"route":{"final":"direct","rule_set":RESOURCES.map(|(name,_)|serde_json::json!({"type":"local","tag":name,"format":"binary","path":generation.join(name)}))}});
    let check_path = generation.join("check.json");
    fs::write(&check_path, validation.to_string()).map_err(|e| e.to_string())?;
    let mut cmd = command(&find_core(app, Core::SingBox)?);
    cmd.args(["check", "-c"]).arg(&check_path);
    let validation_result = capture(cmd);
    let _ = fs::remove_file(check_path);
    validation_result?;
    {
        let state = app.state::<AppState>();
        let _guard = state.rules.lock().map_err(|_| "规则存储不可用")?;
        write_manifest(
            root,
            &Manifest {
                generation: generation_name,
                updated: now(),
                checked: now(),
            },
        )?;
    }
    status(app)
}
