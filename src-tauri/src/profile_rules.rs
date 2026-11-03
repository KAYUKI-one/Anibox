//! Portable sing-box local rule sets. Network access requires the caller's explicit consent.
use crate::{capture, command, find_core, nonce, Core};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingRule {
    pub tag: String,
    pub filename: String,
    pub source: Option<String>,
}
#[derive(Serialize)]
pub struct Preparation {
    pub config: String,
    pub missing: Vec<MissingRule>,
}
pub fn directory() -> Result<PathBuf, String> {
    Ok(std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("程序目录不可用")?
        .to_path_buf())
}
fn filename(tag: &str, path: Option<&str>, source: bool) -> Result<String, String> {
    let name = path
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .filter(|p| !p.is_empty())
        .unwrap_or(tag);
    let extension = if source { ".json" } else { ".srs" };
    let name = if name.ends_with(extension) {
        name.to_owned()
    } else {
        format!("{name}{extension}")
    };
    if name.len() > 160
        || name.contains("..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.@".contains(&c))
    {
        return Err(format!(
            "规则集 {tag} 缺少有效的本地文件名，请指定 path 或远程 url"
        ));
    }
    Ok(name)
}
fn source(name: &str) -> Option<String> {
    if !name.ends_with(".srs") {
        return None;
    }
    let branch = if name.starts_with("geosite-") {
        "rule-set-geosite"
    } else if name.starts_with("geoip-") {
        "rule-set-geoip"
    } else {
        return None;
    };
    Some(format!(
        "https://raw.githubusercontent.com/2dust/sing-box-rules/{branch}/{name}"
    ))
}
fn references(value: &Value, result: &mut BTreeSet<String>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if key == "rule_set" {
                    if let Some(tag) = value.as_str() {
                        result.insert(tag.into());
                    }
                    if let Some(tags) = value.as_array() {
                        for tag in tags {
                            if let Some(tag) = tag.as_str() {
                                result.insert(tag.into());
                            }
                        }
                    }
                } else {
                    references(value, result);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                references(item, result)
            }
        }
        _ => (),
    }
}
fn inspect(config: &str, root: &Path, builtin: Option<&Path>) -> Result<Preparation, String> {
    let mut value: Value = serde_json::from_str(config).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("配置顶层必须是 JSON 对象".into());
    }
    let mut needed = BTreeSet::new();
    references(&value["dns"]["rules"], &mut needed);
    references(&value["route"]["rules"], &mut needed);
    let entries = value
        .pointer("/route/rule_set")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut expanded = vec![];
    for entry in entries {
        if let Some(tags) = entry["tag"].as_array() {
            for tag in tags {
                let tag = tag.as_str().ok_or("规则集 tag 必须为字符串")?;
                let mut item = entry.clone();
                item["tag"] = tag.into();
                for field in ["path", "url", "initial_path"] {
                    if let Some(text) = item[field].as_str() {
                        if !text.contains("{tag}") {
                            return Err(format!("多个规则集的 {field} 需要包含 {{tag}}"));
                        }
                        item[field] = text.replace("{tag}", tag).into();
                    }
                }
                expanded.push(item);
            }
        } else {
            expanded.push(entry);
        }
    }
    let mut declared = BTreeSet::new();
    for entry in &expanded {
        let tag = entry["tag"].as_str().ok_or("规则集缺少 tag")?;
        if !declared.insert(tag.to_owned()) {
            return Err(format!("重复的规则集 tag：{tag}"));
        }
    }
    for tag in needed.difference(&declared) {
        expanded.push(json!({"type":"local","tag":tag,"format":"binary"}));
    }
    let mut missing = vec![];
    for entry in &mut expanded {
        if entry["type"] == "remote" || entry["type"] == "inline" {
            continue;
        }
        let tag = entry["tag"].as_str().ok_or("规则集缺少 tag")?.to_owned();
        let original = entry["path"].as_str();
        let managed_default =
            original.is_some_and(|p| matches!(p, "rules/geosite-cn.srs" | "rules/geoip-cn.srs"));
        if !managed_default && original.is_some_and(|p| root.join(p).is_file()) {
            continue;
        }
        let source_format =
            entry["format"] == "source" || original.is_some_and(|p| p.ends_with(".json"));
        let name = filename(&tag, original, source_format)?;
        let relative = format!("rules/{name}");
        let destination = root.join(&relative);
        // Only the two managed defaults use Anibox's daily refreshed cache.
        if matches!(name.as_str(), "geosite-cn.srs" | "geoip-cn.srs") {
            if let Some(cached) = builtin.map(|p| p.join(&name)).filter(|p| p.is_file()) {
                let bytes = fs::read(cached).map_err(|e| e.to_string())?;
                if fs::read(&destination).ok().as_ref() != Some(&bytes) {
                    fs::create_dir_all(root.join("rules"))
                        .map_err(|e| format!("无法写入程序 rules 目录：{e}"))?;
                    crate::storage::atomic_write(&destination, &bytes)?;
                }
            }
        }
        entry["type"] = "local".into();
        entry["format"] = if source_format { "source" } else { "binary" }.into();
        entry["path"] = relative.into();
        if !destination.is_file() {
            missing.push(MissingRule {
                tag,
                source: source(&name),
                filename: name,
            });
        }
    }
    if !expanded.is_empty() {
        if value.get("route").is_none() {
            value["route"] = json!({});
        }
        if !value["route"].is_object() {
            return Err("route 必须为 JSON 对象".into());
        }
        value["route"]["rule_set"] = expanded.into();
    }
    Ok(Preparation {
        config: serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?,
        missing,
    })
}
pub fn local(app: &tauri::AppHandle, core: Core, config: &str) -> Result<Preparation, String> {
    if !matches!(core, Core::SingBox) {
        return Ok(Preparation {
            config: config.into(),
            missing: vec![],
        });
    }
    let builtin = crate::rules::ensure(app).ok();
    inspect(config, &directory()?, builtin.as_deref())
}
pub fn ready(app: &tauri::AppHandle, core: Core, config: &str) -> Result<String, String> {
    let result = local(app, core, config)?;
    if !result.missing.is_empty() {
        return Err(format!(
            "缺少规则集：{}。请点击连接并确认下载，或指定有效的本地 path / 远程 url。",
            result
                .missing
                .iter()
                .map(|r| r.tag.as_str())
                .collect::<Vec<_>>()
                .join("、")
        ));
    }
    Ok(result.config)
}
fn install(app: &tauri::AppHandle, rule: &MissingRule, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"SRS") {
        return Err(format!("{} 下载内容不是 SRS 规则集", rule.tag));
    }
    let root = directory()?.join("rules");
    fs::create_dir_all(&root).map_err(|e| format!("无法写入程序 rules 目录：{e}"))?;
    let temporary = root.join(format!(".{}-{}.srs", rule.filename, nonce()));
    let check = root.join(format!(".check-{}.json", nonce()));
    let result = (|| {
        fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        fs::write(&check,json!({"outbounds":[{"type":"direct","tag":"direct"}],"route":{"final":"direct","rule_set":[{"type":"local","tag":"download-check","format":"binary","path":temporary}]}}).to_string()).map_err(|e|e.to_string())?;
        let mut cmd = command(&find_core(app, Core::SingBox)?);
        cmd.args(["check", "-c"]).arg(&check);
        capture(cmd).map_err(|_| format!("{} 无法通过当前 sing-box 内核校验", rule.tag))?;
        crate::storage::atomic_write(&root.join(&rule.filename), bytes)
    })();
    let _ = fs::remove_file(temporary);
    let _ = fs::remove_file(check);
    result
}
pub async fn prepare(
    app: tauri::AppHandle,
    core: Core,
    config: String,
    download: bool,
) -> Result<Preparation, String> {
    let handle = app.clone();
    let text = config.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || local(&handle, core, &text))
        .await
        .map_err(|e| e.to_string())??;
    if !download || plan.missing.is_empty() {
        return Ok(plan);
    }
    if let Some(rule) = plan.missing.iter().find(|r| r.source.is_none()) {
        return Err(format!(
            "{} 未找到默认公共来源，请填写远程 url 或导入本地文件",
            rule.tag
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .https_only(true)
        .no_proxy()
        .user_agent(concat!("Anibox/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    for rule in plan.missing {
        let mut response = client
            .get(rule.source.as_ref().unwrap())
            .send()
            .await
            .map_err(|_| format!("{} 下载失败，可检查网络后重试", rule.tag))?
            .error_for_status()
            .map_err(|_| format!("公共规则源未找到 {}，请检查名称或指定远程 url", rule.tag))?;
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| format!("{} 下载中断", rule.tag))?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("规则集超过 8 MB 限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || install(&handle, &rule, &bytes))
            .await
            .map_err(|e| e.to_string())??;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || local(&handle, core, &config))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.local")
            .join(format!("portable-rules-{}", nonce()));
        fs::create_dir_all(root.join("rules")).unwrap();
        root
    }
    #[test]
    fn missing_legacy_paths_and_undeclared_dns_rules_become_portable() {
        let root = root();
        let c = json!({"dns":{"rules":[{"rule_set":["geosite-google"],"server":"dns"}]},"route":{"rule_set":[{"type":"local","tag":"cn","path":"Z:\\other-computer\\geosite-cn.srs"}],"rules":[]},"unknown":{"preserved":true}});
        let plan = inspect(&c.to_string(), &root, None).unwrap();
        let out: Value = serde_json::from_str(&plan.config).unwrap();
        assert_eq!(plan.missing.len(), 2);
        assert_eq!(out["route"]["rule_set"][0]["path"], "rules/geosite-cn.srs");
        assert_eq!(out["unknown"], c["unknown"]);
        fs::write(root.join("rules/geosite-google.srs"), b"fixture").unwrap();
        assert_eq!(inspect(&plan.config, &root, None).unwrap().missing.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn tag_groups_expand_and_arbitrary_names_do_not_become_remote_urls() {
        let root = root();
        let c = json!({"route":{"rule_set":[{"type":"local","tag":["geosite-google","my-private"],"path":"rules/{tag}.srs"},{"type":"inline","tag":"inline","rules":[{"domain":["example.com"]}]}]}});
        let plan = inspect(&c.to_string(), &root, None).unwrap();
        assert!(plan.missing[0].source.is_some());
        assert!(plan.missing[1].source.is_none());
        assert!(filename("../outside", None, false).is_err());
        assert!(filename("safe", Some("rules/../evil.srs"), false).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
