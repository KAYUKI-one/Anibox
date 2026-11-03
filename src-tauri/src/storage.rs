use crate::{app_dir, nonce, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

const PAGES: [&str; 6] = [
    "home",
    "subscriptions",
    "cores",
    "nodes",
    "logs",
    "settings",
];
const IMAGE_LIMIT: usize = 15 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Location {
    directory: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    directory: String,
    config_file: String,
    background_directory: String,
}
fn display(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_string()
    }
}
fn data_root(control: &Path) -> Result<PathBuf, String> {
    let pointer = control.join("storage.json");
    if !pointer.exists() {
        return Ok(control.to_path_buf());
    }
    let location: Location = serde_json::from_slice(&fs::read(pointer).map_err(|e| e.to_string())?)
        .map_err(|_| "storage.json 中的数据目录无效")?;
    if !location.directory.is_absolute() || !location.directory.is_dir() {
        return Err(format!("数据目录不可用：{}", display(&location.directory)));
    }
    Ok(location.directory)
}
fn info(root: &Path) -> StorageInfo {
    StorageInfo {
        directory: display(root),
        config_file: display(&root.join("workspace.json")),
        background_directory: display(&root.join("backgrounds")),
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let next = path.with_extension(format!("{}.next", nonce()));
    fs::write(&next, bytes).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&next, path) {
        if error.raw_os_error() != Some(17) {
            return Err(error.to_string());
        }
        if path.is_file() && path.extension().is_some_and(|e| e == "json") {
            fs::copy(path, path.with_extension("previous.json")).map_err(|e| e.to_string())?;
        }
        fs::copy(&next, path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(next);
    }
    Ok(())
}
fn parse(raw: &str) -> Result<Value, String> {
    if raw.len() > 32 * 1024 * 1024 {
        return Err("配置数据超过 32 MB".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if value["version"] != 1
        || !value["nodes"].is_array()
        || !value["profiles"].is_array()
        || !value["subscriptions"].is_array()
        || !value["settings"].is_object()
    {
        return Err("配置数据格式无效，原文件已保留".into());
    }
    Ok(value)
}
fn image_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    let Some((page, hash)) = stem.rsplit_once('-') else {
        return false;
    };
    PAGES.contains(&page)
        && hash.len() == 24
        && hash.chars().all(|c| c.is_ascii_hexdigit())
        && matches!(ext, "jpg" | "png" | "webp")
}
fn mime(name: &str) -> &'static str {
    if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}
fn write_background(root: &Path, page: &str, data: &str) -> Result<String, String> {
    if !PAGES.contains(&page) {
        return Err("页面无效".into());
    }
    let (prefix, payload) = data.split_once(',').ok_or("背景图片格式无效")?;
    if payload.len() > IMAGE_LIMIT * 4 / 3 + 4 {
        return Err("背景图片超过 15 MB".into());
    }
    let bytes = STANDARD.decode(payload).map_err(|_| "背景图片编码无效")?;
    let extension = match prefix {
        "data:image/jpeg;base64" if bytes.starts_with(&[255, 216, 255]) => "jpg",
        "data:image/png;base64" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => "png",
        "data:image/webp;base64"
            if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) =>
        {
            "webp"
        }
        _ => return Err("请选择 JPEG、PNG 或 WebP 背景图片".into()),
    };
    if bytes.len() > IMAGE_LIMIT {
        return Err("背景图片超过 15 MB".into());
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let name = format!("{page}-{}.{extension}", &hash[..24]);
    let directory = root.join("backgrounds");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    if fs::read(directory.join(&name)).is_ok_and(|existing| existing == bytes) {
        return Ok(name);
    }
    atomic_write(&directory.join(&name), &bytes)?;
    Ok(name)
}
fn normalize(root: &Path, raw: &str) -> Result<String, String> {
    let mut value = parse(raw)?;
    let mut changed = false;
    if let Some(pages) = value
        .pointer_mut("/settings/appearance")
        .and_then(Value::as_object_mut)
    {
        for page in PAGES {
            if let Some(appearance) = pages.get_mut(page).and_then(Value::as_object_mut) {
                if let Some(data) = appearance
                    .get("image")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let name = write_background(root, page, data)?;
                    appearance.insert("imageFile".into(), name.into());
                    appearance.remove("image");
                    changed = true;
                }
                if let Some(name) = appearance.get("imageFile").and_then(Value::as_str) {
                    if !image_name(name) {
                        return Err("背景文件名无效".into());
                    }
                }
            }
        }
    }
    if changed {
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
    } else {
        Ok(raw.to_string())
    }
}
fn read_background(root: &Path, name: &str) -> Result<Option<String>, String> {
    if !image_name(name) {
        return Err("背景文件名无效".into());
    }
    let path = root.join("backgrounds").join(name);
    if !path.is_file() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > IMAGE_LIMIT as u64 {
        return Err("背景图片超过 15 MB".into());
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    Ok(Some(format!(
        "data:{};base64,{}",
        mime(name),
        STANDARD.encode(data)
    )))
}
pub fn load(root: &Path) -> Result<Option<String>, String> {
    let file = root.join("workspace.json");
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let normalized = normalize(root, &raw)?;
    if normalized != raw {
        atomic_write(&file, normalized.as_bytes())?;
    }
    Ok(Some(normalized))
}
pub fn save(root: &Path, raw: &str) -> Result<(), String> {
    let raw = normalize(root, raw)?;
    atomic_write(&root.join("workspace.json"), raw.as_bytes())
}
async fn locked<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&Path, &Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _lock = state.storage.lock().map_err(|_| "配置存储不可用")?;
        let control = app_dir(&app)?;
        let root = data_root(&control)?;
        operation(&control, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn load_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    locked(app, |_, root| load(root)).await
}
#[tauri::command]
pub async fn save_data(app: tauri::AppHandle, data: String) -> Result<(), String> {
    locked(app, move |_, root| save(root, &data)).await
}
#[tauri::command]
pub async fn storage_info(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    locked(app, |_, root| {
        fs::create_dir_all(root.join("backgrounds")).map_err(|e| e.to_string())?;
        Ok(info(root))
    })
    .await
}
#[tauri::command]
pub async fn store_background(
    app: tauri::AppHandle,
    page: String,
    data: String,
) -> Result<String, String> {
    locked(app, move |_, root| write_background(root, &page, &data)).await
}
#[tauri::command]
pub async fn load_background(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    locked(app, move |_, root| read_background(root, &name)).await
}
fn portable(root: &Path, raw: &str) -> Result<String, String> {
    let mut value = parse(raw)?;
    if let Some(pages) = value
        .pointer_mut("/settings/appearance")
        .and_then(Value::as_object_mut)
    {
        for appearance in pages.values_mut().filter_map(Value::as_object_mut) {
            if let Some(name) = appearance.get("imageFile").and_then(Value::as_str) {
                if let Some(data) = read_background(root, name)? {
                    appearance.insert("image".into(), data.into());
                }
                appearance.remove("imageFile");
            }
        }
    }
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn export_data(app: tauri::AppHandle, data: String) -> Result<String, String> {
    locked(app, move |_, root| portable(root, &data)).await
}
fn clear_images(value: &mut Value, page: Option<&str>) {
    if let Some(appearances) = value
        .pointer_mut("/settings/appearance")
        .and_then(Value::as_object_mut)
    {
        for (key, appearance) in appearances.iter_mut() {
            if page.is_none_or(|page| page == key) {
                if let Some(a) = appearance.as_object_mut() {
                    a.remove("image");
                    a.remove("imageFile");
                    a.insert("opacity".into(), 54.into());
                    a.remove("focus");
                    a.remove("focusMode");
                    a.insert("blur".into(), 0.into());
                }
            }
        }
    }
}
#[tauri::command]
pub async fn reset_backgrounds(
    app: tauri::AppHandle,
    data: String,
    page: Option<String>,
) -> Result<String, String> {
    locked(app, move |_, root| {
        if page.as_deref().is_some_and(|p| !PAGES.contains(&p)) {
            return Err("页面无效".into());
        }
        let mut value = parse(&data)?;
        clear_images(&mut value, page.as_deref());
        let raw = normalize(
            root,
            &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
        )?;
        save(root, &raw)?;
        // Remove inline photos from recovery copies too, so a reset cannot
        // resurrect the previous image when recovering the local settings.
        for name in ["workspace.previous.json", "workspace.next.json"] {
            let path = root.join(name);
            if let Some(mut backup) = fs::read_to_string(&path).ok().and_then(|s| parse(&s).ok()) {
                clear_images(&mut backup, page.as_deref());
                fs::write(
                    path,
                    serde_json::to_vec_pretty(&backup).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let current: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let used: Vec<&str> = current
            .pointer("/settings/appearance")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|a| a.values())
            .filter_map(|a| a.get("imageFile").and_then(Value::as_str))
            .collect();
        if let Ok(entries) = fs::read_dir(root.join("backgrounds")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if image_name(&name)
                    && !used.contains(&name.as_str())
                    && entry.file_type().is_ok_and(|t| t.is_file())
                {
                    fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(raw)
    })
    .await
}
fn migrate(
    control: &Path,
    source: &Path,
    destination: &Path,
    raw: &str,
) -> Result<StorageInfo, String> {
    if !destination.is_absolute() {
        return Err("请选择绝对目录".into());
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let destination = fs::canonicalize(destination).map_err(|e| e.to_string())?;
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    if destination
        .to_string_lossy()
        .eq_ignore_ascii_case(&source.to_string_lossy())
    {
        return Ok(info(&source));
    }
    if destination.starts_with(source.join("backgrounds")) {
        return Err("不能将背景子目录作为配置目录".into());
    }
    if destination.join("workspace.json").exists()
        || fs::read_dir(destination.join("backgrounds")).is_ok_and(|mut i| i.next().is_some())
    {
        return Err("目标目录已有配置或背景，请选择新的空目录".into());
    }
    // Normalize before copying so legacy embedded images are included.
    let raw = normalize(&source, raw)?;
    fs::create_dir_all(destination.join("backgrounds")).map_err(|e| e.to_string())?;
    if let Ok(entries) = fs::read_dir(source.join("backgrounds")) {
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_file()
                && image_name(&entry.file_name().to_string_lossy())
            {
                fs::copy(
                    entry.path(),
                    destination.join("backgrounds").join(entry.file_name()),
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    atomic_write(&destination.join("workspace.json"), raw.as_bytes())?;
    // The old location remains usable until the complete copy is committed.
    atomic_write(
        &control.join("storage.json"),
        &serde_json::to_vec(&Location {
            directory: destination.clone(),
        })
        .map_err(|e| e.to_string())?,
    )?;
    Ok(info(&destination))
}
#[tauri::command]
pub async fn set_storage_directory(
    app: tauri::AppHandle,
    directory: String,
    data: String,
) -> Result<StorageInfo, String> {
    locked(app, move |control, root| {
        migrate(control, root, Path::new(&directory), &data)
    })
    .await
}
#[tauri::command]
pub async fn open_storage_folder(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    locked(app, move |control, root| {
        let directory = match folder.as_str() {
            "config" => root.to_path_buf(),
            "backgrounds" => root.join("backgrounds"),
            "logs" => control.join("logs"),
            _ => return Err("目录无效".into()),
        };
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        std::process::Command::new(
            PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                .join("explorer.exe"),
        )
        .arg(display(&directory))
        .spawn()
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn choose_storage_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let owner = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as usize)
        .unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::spawn(move || pick_folder(owner))
            .join()
            .map_err(|_| "目录选择失败".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(windows)]
fn pick_folder(owner: usize) -> Result<Option<String>, String> {
    use windows::Win32::{
        Foundation::HWND,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
            SIGDN_FILESYSPATH,
        },
    };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<Option<String>> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
            if let Err(error) = dialog.Show(Some(HWND(owner as _))) {
                if error.code().0 as u32 == 0x800704c7 {
                    return Ok(None);
                }
                return Err(error);
            }
            let display = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = display.to_string();
            CoTaskMemFree(Some(display.0 as _));
            Ok(Some(path?))
        })();
        CoUninitialize();
        result.map_err(|e| e.to_string())
    }
}
#[cfg(not(windows))]
fn pick_folder(_: usize) -> Result<Option<String>, String> {
    Err("目录选择目前仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("anibox-storage-test-{}", nonce()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn directory(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("anibox-storage-test-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn data() -> Value {
        serde_json::json!({"version":1,"nodes":[{"id":"node","outbound":{"future_field":42}}],"subscriptions":[],
            "profiles":[{"content":"{\n  \"outbounds\": [], \"future_field\": 42\n}"}],
            "settings":{"port":10808,"appearance":{"home":{"opacity":78,"blur":0,"image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII="}}}})
    }
    #[test]
    fn legacy_photos_become_files_and_backups_remain_portable() {
        let fixture = Fixture::new();
        let root = fixture.directory("data");
        let original = data();
        fs::write(root.join("workspace.json"), original.to_string()).unwrap();
        let raw = load(&root).unwrap().unwrap();
        let migrated: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(migrated["profiles"], original["profiles"]);
        assert_eq!(migrated["nodes"], original["nodes"]);
        let name = migrated["settings"]["appearance"]["home"]["imageFile"]
            .as_str()
            .unwrap();
        assert!(image_name(name));
        assert!(!raw.contains("data:image"));
        assert_eq!(
            read_background(&root, name).unwrap().unwrap(),
            original["settings"]["appearance"]["home"]["image"]
                .as_str()
                .unwrap()
        );
        let backup: Value = serde_json::from_str(&portable(&root, &raw).unwrap()).unwrap();
        assert_eq!(backup, original);
        fs::remove_file(root.join("backgrounds").join(name)).unwrap();
        assert!(read_background(&root, name).unwrap().is_none());
    }
    #[test]
    fn migration_preserves_configuration_and_switches_locator_only_after_copy() {
        let fixture = Fixture::new();
        let control = fixture.directory("control");
        let destination = fixture.directory("新位置 data");
        save(&control, &data().to_string()).unwrap();
        let before = load(&control).unwrap().unwrap();
        migrate(&control, &control, &destination, &before).unwrap();
        let root = data_root(&control).unwrap();
        assert_eq!(
            fs::canonicalize(&root).unwrap(),
            fs::canonicalize(&destination).unwrap()
        );
        assert_eq!(load(&root).unwrap().unwrap(), before);
        assert_eq!(load(&control).unwrap().unwrap(), before);
        let value: Value = serde_json::from_str(&before).unwrap();
        assert!(read_background(
            &root,
            value["settings"]["appearance"]["home"]["imageFile"]
                .as_str()
                .unwrap()
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn migration_never_overwrites_an_existing_destination() {
        let fixture = Fixture::new();
        let control = fixture.directory("control");
        let destination = fixture.directory("existing");
        save(&control, &data().to_string()).unwrap();
        fs::write(destination.join("workspace.json"), b"unrelated data").unwrap();
        assert!(migrate(&control, &control, &destination, &data().to_string()).is_err());
        assert_eq!(
            fs::read(destination.join("workspace.json")).unwrap(),
            b"unrelated data"
        );
        assert!(!control.join("storage.json").exists());
    }
    #[test]
    fn missing_custom_directory_does_not_reset_to_old_default_data() {
        let fixture = Fixture::new();
        let control = fixture.directory("control");
        fs::write(
            control.join("storage.json"),
            serde_json::to_vec(&Location {
                directory: fixture.0.join("missing"),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(data_root(&control).is_err());
    }
    #[test]
    fn background_names_cannot_reference_arbitrary_files() {
        for invalid in [
            "../workspace.json",
            "C:/photo.jpg",
            "home-../secret.jpg",
            "unknown-0123456789abcdef01234567.jpg",
        ] {
            assert!(!image_name(invalid));
        }
        let fixture = Fixture::new();
        assert!(write_background(&fixture.0, "../home", "data:image/jpeg;base64,/9j/").is_err());
        assert!(write_background(
            &fixture.0,
            "home",
            "data:image/jpeg;base64,bm90IGEganBlZw=="
        )
        .is_err());
    }
}
