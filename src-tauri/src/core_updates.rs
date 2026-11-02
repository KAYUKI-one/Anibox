use crate::{
    app_dir, bundled_core, capture, command, find_core, nonce, prepare_runtime, AppState, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

const DAY: u64 = 86_400_000;
const MAX_ARCHIVE: u64 = 160 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdate {
    core: Core,
    current_version: Option<String>,
    latest_version: Option<String>,
    available: bool,
    rollback_available: bool,
    error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Release {
    version: String,
    name: String,
    url: String,
    sha256: String,
    size: u64,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GithubAsset>,
}
#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}
#[derive(Serialize, Deserialize)]
struct CachedRelease {
    checked: u64,
    release: Release,
}
#[derive(Clone, Serialize, Deserialize)]
struct Installed {
    version: String,
    generation: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Active {
    current: Option<Installed>,
    previous: Option<Installed>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn repository(core: Core) -> &'static str {
    match core {
        Core::Xray => "XTLS/Xray-core",
        Core::SingBox => "SagerNet/sing-box",
    }
}
fn version(value: &str) -> Option<(String, [u64; 3])> {
    let value = value.strip_prefix('v').unwrap_or(value);
    if value.len() > 40 || !value.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let parts = value
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.len() != 3 {
        return None;
    }
    Some((value.into(), [parts[0], parts[1], parts[2]]))
}
fn binary_version(exe: &Path) -> Result<String, String> {
    let mut cmd = command(exe);
    cmd.arg("version");
    let output = capture(cmd)?;
    output
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .find_map(|word| version(word).map(|v| v.0))
        .ok_or("无法识别内核版本".into())
}
fn root(app: &tauri::AppHandle, core: Core) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("cores").join(core.name()))
}
fn read_active(root: &Path) -> Active {
    ["active.json", "active.previous.json"]
        .into_iter()
        .find_map(|name| {
            fs::read(root.join(name))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
        })
        .unwrap_or_default()
}
fn publish_candidate(source: &Path, destination: &Path) -> Result<(), String> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(17) => {
            // Windows redirected profiles may report EXDEV for sibling paths.
            // The active manifest is switched only after every file is copied.
            fs::create_dir(destination).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    return Err("内核目录包含非文件资源".into());
                }
                fs::copy(entry.path(), destination.join(entry.file_name()))
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}
fn generation_path(root: &Path, item: &Installed, core: Core) -> Option<PathBuf> {
    version(&item.version)?;
    let name = &item.generation;
    if name.len() > 120
        || !name.starts_with(&format!("{}-", item.version))
        || !name
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == '-')
    {
        return None;
    }
    let path = root.join(name).join(core.exe());
    path.is_file().then_some(path)
}
pub fn installed(app: &tauri::AppHandle, core: Core) -> Option<PathBuf> {
    installed_in(&app_dir(app).ok()?, core)
}
pub fn installed_in(data_root: &Path, core: Core) -> Option<PathBuf> {
    let root = data_root.join("cores").join(core.name());
    generation_path(&root, &read_active(&root).current?, core)
}
fn progress(app: &tauri::AppHandle, core: Core, phase: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "core-update-progress",
        serde_json::json!({"core":core,"phase":phase,"downloaded":downloaded,"total":total}),
    );
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let next = path.with_extension(format!("{}.next", nonce()));
    fs::write(&next, serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&next, path) {
        if error.raw_os_error() != Some(17) {
            return Err(error.to_string());
        }
        if path.is_file() {
            fs::copy(path, path.with_extension("previous.json")).map_err(|e| e.to_string())?;
        }
        fs::copy(&next, path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(next);
    }
    Ok(())
}
fn client(app: &tauri::AppHandle) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .timeout(Duration::from_secs(25))
        .user_agent(concat!("Anibox/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 8 {
                return attempt.error("too many redirects");
            }
            if attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "api.github.com"
                            | "objects.githubusercontent.com"
                            | "release-assets.githubusercontent.com"
                            | "github-releases.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.error("unexpected release host")
            }
        }));
    // Prefer the application's current HTTP inbound when GitHub needs a proxy.
    if let Ok(runtime) = app.state::<AppState>().runtime.lock() {
        if let (Some(core), Some(config)) = (runtime.status.core, runtime.config.as_deref()) {
            if let Ok(port) = crate::http_port(config, core) {
                builder = builder.proxy(
                    reqwest::Proxy::https(format!("http://127.0.0.1:{port}"))
                        .map_err(|e| e.to_string())?,
                );
            }
        }
    }
    builder.build().map_err(|e| e.to_string())
}
fn select_release(core: Core, data: GithubRelease) -> Result<Release, String> {
    if data.draft || data.prerelease {
        return Err("忽略测试版内核".into());
    }
    let (ver, _) = version(&data.tag_name).ok_or("上游版本格式无效")?;
    let name = match (core, std::env::consts::ARCH) {
        (Core::Xray, "x86_64") => "Xray-windows-64.zip".into(),
        (Core::Xray, "aarch64") => "Xray-windows-arm64-v8a.zip".into(),
        (Core::SingBox, "x86_64") => format!("sing-box-{ver}-windows-amd64.zip"),
        (Core::SingBox, "aarch64") => format!("sing-box-{ver}-windows-arm64.zip"),
        _ => return Err("当前架构暂不支持自动更新".into()),
    };
    let asset = data
        .assets
        .into_iter()
        .find(|a| a.name == name)
        .ok_or("上游缺少对应的 Windows 发布包")?;
    let expected = format!(
        "https://github.com/{}/releases/download/{}/{}",
        repository(core),
        data.tag_name,
        name
    );
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or("上游未提供 SHA256，已保留当前内核")?;
    if asset.browser_download_url != expected
        || asset.size == 0
        || asset.size > MAX_ARCHIVE
        || sha256.len() != 64
        || !sha256.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("上游发布信息无效".into());
    }
    Ok(Release {
        version: ver,
        name,
        url: expected,
        sha256: sha256.to_lowercase(),
        size: asset.size,
    })
}
async fn fetch_release(
    app: &tauri::AppHandle,
    core: Core,
    tag: Option<&str>,
) -> Result<Release, String> {
    let endpoint = match tag {
        Some(tag) => format!("tags/v{}", version(tag).ok_or("版本无效")?.0),
        None => "latest".into(),
    };
    let mut response = client(app)?
        .get(format!(
            "https://api.github.com/repos/{}/releases/{endpoint}",
            repository(core)
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络或代理")?
        .error_for_status()
        .map_err(|e| {
            format!(
                "检查内核更新失败：{}",
                e.status().map(|s| s.as_u16()).unwrap_or(0)
            )
        })?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取发布信息失败")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("发布信息过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    select_release(
        core,
        serde_json::from_slice(&bytes).map_err(|_| "GitHub 发布信息格式无效")?,
    )
}
fn describe(
    app: &tauri::AppHandle,
    core: Core,
    release: Option<Release>,
    error: Option<String>,
) -> CoreUpdate {
    let current_version = find_core(app, core)
        .ok()
        .and_then(|p| binary_version(&p).ok());
    let available = release.as_ref().is_some_and(|r| {
        current_version
            .as_ref()
            .and_then(|v| version(v))
            .is_none_or(|v| version(&r.version).is_some_and(|latest| latest.1 > v.1))
    });
    let state = root(app, core)
        .ok()
        .map(|r| read_active(&r))
        .unwrap_or_default();
    CoreUpdate {
        core,
        current_version,
        latest_version: release.map(|r| r.version),
        available,
        rollback_available: state.current.is_some() || state.previous.is_some(),
        error,
    }
}
#[tauri::command]
pub async fn check_core_updates(
    app: tauri::AppHandle,
    force: bool,
) -> Result<Vec<CoreUpdate>, String> {
    let mut results = Vec::new();
    for core in [Core::Xray, Core::SingBox] {
        let a = app.clone();
        let cached = tauri::async_runtime::spawn_blocking(move || {
            let path = root(&a, core)?.join("latest.json");
            Ok::<Option<CachedRelease>, String>(
                fs::read(path)
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok()),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        let (release, error) = if !force
            && cached
                .as_ref()
                .is_some_and(|c| now().saturating_sub(c.checked) < DAY)
        {
            (cached.map(|c| c.release), None)
        } else {
            match fetch_release(&app, core, None).await {
                Ok(release) => {
                    let a = app.clone();
                    let saved = release.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let root = root(&a, core)?;
                        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
                        write_json(
                            &root.join("latest.json"),
                            &CachedRelease {
                                checked: now(),
                                release: saved,
                            },
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                    (Some(release), None)
                }
                Err(error) => (cached.map(|c| c.release), Some(error)),
            }
        };
        let a = app.clone();
        results.push(
            tauri::async_runtime::spawn_blocking(move || describe(&a, core, release, error))
                .await
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(results)
}
struct UpdateGuard(tauri::AppHandle);
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.0.state::<AppState>().updating_cores.lock() {
            *busy = false;
        }
    }
}
fn update_guard(app: &tauri::AppHandle) -> Result<UpdateGuard, String> {
    let state = app.state::<AppState>();
    let mut busy = state.updating_cores.lock().map_err(|_| "内核更新不可用")?;
    if *busy {
        return Err("已有内核正在更新".into());
    }
    *busy = true;
    Ok(UpdateGuard(app.clone()))
}
struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn extract(archive: &Path, destination: &Path, core: Core) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 512 {
        return Err("发布包文件数异常".into());
    }
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    let mut names = HashSet::new();
    let mut size = 0u64;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|e| e.to_string())?;
        let path = file.enclosed_name().ok_or("发布包路径无效")?;
        if file.is_dir() {
            continue;
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("发布包包含符号链接".into());
        }
        size = size.checked_add(file.size()).ok_or("发布包大小异常")?;
        if size > 512 * 1024 * 1024 {
            return Err("解压后发布包过大".into());
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("发布包文件名无效")?;
        let allowed = name == core.exe()
            || matches!(
                name,
                "wintun.dll" | "libcronet.dll" | "LICENSE" | "LICENSE-Wintun"
            )
            || matches!(core, Core::Xray) && matches!(name, "geoip.dat" | "geosite.dat");
        if !allowed {
            continue;
        }
        if !names.insert(name.to_lowercase()) {
            return Err("发布包包含重复文件".into());
        }
        let length = file.size();
        let mut out = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination.join(name))
            .map_err(|e| e.to_string())?;
        let actual = std::io::copy(&mut file.by_ref().take(200 * 1024 * 1024 + 1), &mut out)
            .map_err(|e| e.to_string())?;
        if actual != length || actual > 200 * 1024 * 1024 {
            return Err("发布包文件大小无效".into());
        }
        out.flush().map_err(|e| e.to_string())?;
    }
    if !destination.join(core.exe()).is_file() || !destination.join("LICENSE").is_file() {
        return Err("发布包缺少内核或许可文件".into());
    }
    Ok(())
}
fn verify_candidate(
    app: &tauri::AppHandle,
    core: Core,
    directory: &Path,
    expected: &str,
    config: Option<String>,
    managed: bool,
) -> Result<(), String> {
    let exe = directory.join(core.exe());
    if binary_version(&exe)? != expected {
        return Err("内核版本与发布版本不一致".into());
    }
    let config = match config {
        Some(config) => prepare_runtime(app, core, &config, managed)?.0,
        None => match core {
            Core::Xray => r#"{"outbounds":[{"protocol":"freedom","tag":"direct"}]}"#.into(),
            Core::SingBox => r#"{"outbounds":[{"type":"direct","tag":"direct"}]}"#.into(),
        },
    };
    let path = directory.join("update-check.json");
    fs::write(&path, config).map_err(|e| e.to_string())?;
    let mut cmd = command(&exe);
    match core {
        Core::Xray => {
            cmd.args(["run", "-test", "-c"]);
        }
        Core::SingBox => {
            cmd.args(["check", "-c"]);
        }
    }
    let result = capture({
        cmd.arg(&path);
        cmd
    });
    let _ = fs::remove_file(path);
    result
        .map(|_| ())
        .map_err(|e| format!("新版内核校验未通过，已保留旧版：{e}"))
}
#[tauri::command]
pub async fn install_core_update(
    app: tauri::AppHandle,
    core: Core,
    version: String,
    config: Option<String>,
    managed: Option<bool>,
) -> Result<CoreUpdate, String> {
    let _guard = update_guard(&app)?;
    progress(&app, core, "准备中", 0, 0);
    let release = fetch_release(&app, core, Some(&version)).await?;
    if release.version != version {
        return Err("发布版本不一致".into());
    }
    let a = app.clone();
    let next = release.version.clone();
    let (current, directory, stage) = tauri::async_runtime::spawn_blocking(move || {
        let current = find_core(&a, core).ok();
        if let Some(current) = current
            .as_ref()
            .and_then(|p| binary_version(p).ok())
            .and_then(|v| self::version(&v))
        {
            if self::version(&next).is_none_or(|next| next.1 <= current.1) {
                return Err("当前内核已是相同或更新版本".into());
            }
        }
        let directory = root(&a, core)?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let stage = Stage(directory.join(format!("stage-{}", crate::tun::random_token()?)));
        fs::create_dir(&stage.0).map_err(|e| e.to_string())?;
        Ok::<_, String>((current, directory, stage))
    })
    .await
    .map_err(|e| e.to_string())??;
    let archive = stage.0.join("release.zip");
    let mut response = client(&app)?
        .get(&release.url)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|_| "内核下载失败，已保留旧版")?
        .error_for_status()
        .map_err(|_| "GitHub 下载失败，已保留旧版")?;
    let mut output = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut notified = 0u64;
    progress(&app, core, "下载中", 0, release.size);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "内核下载中断，已保留旧版")?
    {
        size += chunk.len() as u64;
        if size > MAX_ARCHIVE || size > release.size {
            return Err("下载的内核大小异常".into());
        }
        hasher.update(&chunk);
        output.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if size.saturating_sub(notified) >= 1024 * 1024 {
            progress(&app, core, "下载中", size, release.size);
            notified = size;
        }
    }
    output.flush().await.map_err(|e| e.to_string())?;
    drop(output);
    if size != release.size || format!("{:x}", hasher.finalize()) != release.sha256 {
        return Err("内核 SHA256 校验失败，已保留旧版".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        progress(&app, core, "校验中", release.size, release.size);
        let state = app.state::<AppState>();
        let _install = state.core_install.lock().map_err(|_| "内核更新不可用")?;
        let candidate = stage.0.join("core");
        extract(&archive, &candidate, core)?;
        let previous = current.or_else(|| {
            if matches!(core, Core::SingBox) {
                find_core(&app, Core::Xray).ok()
            } else {
                None
            }
        });
        if let Some(previous) = previous.and_then(|p| p.parent().map(Path::to_path_buf)) {
            for name in ["wintun.dll", "LICENSE-Wintun", "geoip.dat", "geosite.dat"] {
                if matches!(core, Core::SingBox) && name.ends_with(".dat") {
                    continue;
                }
                if !candidate.join(name).exists() && previous.join(name).is_file() {
                    fs::copy(previous.join(name), candidate.join(name))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        verify_candidate(
            &app,
            core,
            &candidate,
            &release.version,
            config,
            managed.unwrap_or(false),
        )?;
        let generation = format!(
            "{}-{}-{}",
            release.version,
            &release.sha256[..12],
            &crate::tun::random_token()?[..8]
        );
        publish_candidate(&candidate, &directory.join(&generation))?;
        let mut active = read_active(&directory);
        active.previous = active.current.take();
        active.current = Some(Installed {
            version: release.version.clone(),
            generation,
        });
        write_json(&directory.join("active.json"), &active)?;
        progress(&app, core, "完成", release.size, release.size);
        Ok(describe(&app, core, Some(release), None))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn fixture(files: &[(&str, &[u8])]) -> Stage {
        let stage = Stage(std::env::temp_dir().join(format!("anibox-update-test-{}", nonce())));
        fs::create_dir(&stage.0).unwrap();
        let mut zip = ZipWriter::new(fs::File::create(stage.0.join("release.zip")).unwrap());
        for (name, bytes) in files {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        stage
    }
    #[test]
    fn compares_calendar_and_semantic_versions_numerically() {
        assert!(version("v26.10.1").unwrap().1 > version("26.9.30").unwrap().1);
        assert!(version("1.15.0").unwrap().1 > version("1.14.4").unwrap().1);
        for invalid in [
            "../1.14.4",
            "+1.14.4",
            "1.14.4-beta.1",
            "1.14",
            "1.14.4/asset",
        ] {
            assert!(version(invalid).is_none());
        }
    }
    #[test]
    fn rejects_untrusted_release_url_and_missing_digest() {
        let name = if cfg!(target_arch = "aarch64") {
            "Xray-windows-arm64-v8a.zip"
        } else {
            "Xray-windows-64.zip"
        };
        for (url, digest) in [
            (
                format!("https://example.com/{name}"),
                Some(format!("sha256:{}", "a".repeat(64))),
            ),
            (
                format!("https://github.com/XTLS/Xray-core/releases/download/v26.10.31/{name}"),
                None,
            ),
        ] {
            let release = GithubRelease {
                tag_name: "v26.10.31".into(),
                draft: false,
                prerelease: false,
                assets: vec![GithubAsset {
                    name: name.into(),
                    browser_download_url: url,
                    digest,
                    size: 100,
                }],
            };
            assert!(select_release(Core::Xray, release).is_err());
        }
    }
    #[test]
    fn extracts_only_expected_resources_from_nested_archives() {
        let stage = fixture(&[
            ("sing-box-1.14.4/sing-box.exe", b"core"),
            ("sing-box-1.14.4/LICENSE", b"license"),
            ("sing-box-1.14.4/launch.cmd", b"ignored"),
        ]);
        let destination = stage.0.join("candidate");
        extract(&stage.0.join("release.zip"), &destination, Core::SingBox).unwrap();
        assert_eq!(fs::read(destination.join("sing-box.exe")).unwrap(), b"core");
        assert!(!destination.join("launch.cmd").exists());
    }
    #[test]
    fn rejects_archive_path_escape_and_duplicate_executable_names() {
        for files in [
            vec![
                ("../xray.exe", b"bad".as_slice()),
                ("LICENSE", b"license".as_slice()),
            ],
            vec![
                ("a/xray.exe", b"first".as_slice()),
                ("b/xray.exe", b"second".as_slice()),
                ("LICENSE", b"license".as_slice()),
            ],
        ] {
            let stage = fixture(&files);
            assert!(extract(
                &stage.0.join("release.zip"),
                &stage.0.join("candidate"),
                Core::Xray
            )
            .is_err());
            assert!(!stage.0.join("xray.exe").exists());
        }
    }
    #[test]
    fn installed_manifest_cannot_escape_core_directory() {
        let root = Path::new("C:/Anibox-test");
        let item = Installed {
            version: "1.14.4".into(),
            generation: "1.14.4-../../outside".into(),
        };
        assert!(generation_path(root, &item, Core::SingBox).is_none());
    }
}
#[tauri::command]
pub async fn rollback_core(app: tauri::AppHandle, core: Core) -> Result<CoreUpdate, String> {
    let _guard = update_guard(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _install = state.core_install.lock().map_err(|_| "内核更新不可用")?;
        let root = root(&app, core)?;
        let mut active = read_active(&root);
        if active.current.is_none() && active.previous.is_none() {
            return Err("没有可回退的版本".into());
        }
        let target = if let Some(previous) = active.previous.as_ref() {
            generation_path(&root, previous, core).ok_or("回退版本文件缺失")?
        } else {
            bundled_core(&app, core)?
        };
        binary_version(&target)?;
        std::mem::swap(&mut active.current, &mut active.previous);
        write_json(&root.join("active.json"), &active)?;
        let latest = fs::read(root.join("latest.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<CachedRelease>(&bytes).ok())
            .map(|cached| cached.release);
        Ok(describe(&app, core, latest, None))
    })
    .await
    .map_err(|e| e.to_string())?
}
