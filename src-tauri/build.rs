fn main() {
    let base: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("tauri.conf.json").expect("Missing Tauri config"),
    )
    .expect("Invalid Tauri config");
    let overlay: serde_json::Value = std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let id = overlay["identifier"]
        .as_str()
        .or_else(|| base["identifier"].as_str())
        .expect("Missing application identifier");
    println!("cargo:rustc-env=ANIBOX_APP_ID={id}");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    tauri_build::build()
}
