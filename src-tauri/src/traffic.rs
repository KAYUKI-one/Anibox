use crate::Core;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    net::TcpListener,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Endpoint {
    pub core: Core,
    pub port: u16,
    pub secret: String,
}
#[derive(Default)]
pub struct Sampler {
    pub previous: Option<(u32, Instant, u64, u64)>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStats {
    pub available: bool,
    pub upload_total: u64,
    pub download_total: u64,
    pub upload_speed: f64,
    pub download_speed: f64,
}

pub fn instrument(value: &mut Value, core: Core) -> Result<Endpoint, String> {
    let port = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| e.to_string())?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let endpoint = Endpoint {
        core,
        port,
        secret: crate::tun::random_token()?,
    };
    match core {
        Core::Xray => {
            value["stats"] = json!({});
            if !value["policy"].is_object() {
                value["policy"] = json!({});
            }
            value["policy"]["system"] =
                json!({"statsInboundUplink":true,"statsInboundDownlink":true});
            value["metrics"] = json!({"tag":"anibox-metrics","listen":format!("127.0.0.1:{port}")});
        }
        Core::SingBox => {
            if !value["experimental"].is_object() {
                value["experimental"] = json!({});
            }
            value["experimental"]["clash_api"] = json!({"external_controller":format!("127.0.0.1:{port}"),"secret":endpoint.secret,"access_control_allow_origin":["http://tauri.localhost"]});
        }
    }
    Ok(endpoint)
}
pub fn detect(value: &Value, core: Core) -> Option<Endpoint> {
    let address = match core {
        Core::Xray => value.pointer("/metrics/listen")?,
        Core::SingBox => value.pointer("/experimental/clash_api/external_controller")?,
    }
    .as_str()?;
    let address: std::net::SocketAddr = address.parse().ok()?;
    if !address.ip().is_loopback() {
        return None;
    }
    Some(Endpoint {
        core,
        port: address.port(),
        secret: value
            .pointer("/experimental/clash_api/secret")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
    })
}
pub async fn totals(endpoint: &Endpoint) -> Result<(u64, u64), String> {
    let path = match endpoint.core {
        Core::Xray => "/debug/vars",
        Core::SingBox => "/connections",
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(900))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client
        .get(format!("http://127.0.0.1:{}{}", endpoint.port, path))
        .bearer_auth(&endpoint.secret)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    parse_totals(&value, endpoint.core)
}
fn parse_totals(value: &Value, core: Core) -> Result<(u64, u64), String> {
    match core {
        Core::Xray => {
            let inbounds = value
                .pointer("/stats/inbound")
                .and_then(Value::as_object)
                .ok_or("统计未就绪")?;
            Ok(inbounds
                .iter()
                .filter(|(tag, _)| !["api", "metrics", "anibox-metrics"].contains(&tag.as_str()))
                .fold((0, 0), |(up, down), (_, value)| {
                    (
                        up + value["uplink"].as_u64().unwrap_or(0),
                        down + value["downlink"].as_u64().unwrap_or(0),
                    )
                }))
        }
        Core::SingBox => Ok((
            value["uploadTotal"].as_u64().ok_or("统计未就绪")?,
            value["downloadTotal"].as_u64().ok_or("统计未就绪")?,
        )),
    }
}
impl Sampler {
    pub fn sample(&mut self, pid: u32, upload: u64, download: u64) -> TrafficStats {
        let now = Instant::now();
        let (up_speed, down_speed) = self
            .previous
            .filter(|(previous_pid, _, _, _)| *previous_pid == pid)
            .map(|(_, time, up, down)| {
                let seconds = now.duration_since(time).as_secs_f64().max(0.001);
                (
                    upload.saturating_sub(up) as f64 / seconds,
                    download.saturating_sub(down) as f64 / seconds,
                )
            })
            .unwrap_or((0., 0.));
        self.previous = Some((pid, now, upload, download));
        TrafficStats {
            available: true,
            upload_total: upload,
            download_total: download,
            upload_speed: up_speed,
            download_speed: down_speed,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_inbounds_once_and_excludes_management_traffic() {
        let value = json!({"stats":{"inbound":{"socks":{"uplink":20,"downlink":50},"tun-in":{"uplink":30,"downlink":40},"metrics":{"uplink":1000,"downlink":1000}},"outbound":{"proxy":{"uplink":50,"downlink":90}}}});
        assert_eq!(parse_totals(&value, Core::Xray).unwrap(), (50, 90));
    }
    #[test]
    fn uses_clash_cumulative_totals() {
        assert_eq!(
            parse_totals(
                &json!({"uploadTotal":1024,"downloadTotal":4096}),
                Core::SingBox
            )
            .unwrap(),
            (1024, 4096)
        );
    }
}
