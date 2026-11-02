use crate::Core;
use serde::Serialize;
use serde_json::Value;
use std::net::{TcpListener, UdpSocket};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPorts {
    pub socks: u16,
    pub http: u16,
}

pub struct Reservation {
    pub ports: LocalPorts,
    pub changed: bool,
    _tcp: [TcpListener; 2],
    _udp: UdpSocket,
}

fn reserve(port: u16, original: u16) -> Option<Reservation> {
    if !(1024..65535).contains(&port) {
        return None;
    }
    let socks = TcpListener::bind(("127.0.0.1", port)).ok()?;
    let http = TcpListener::bind(("127.0.0.1", port + 1)).ok()?;
    let udp = UdpSocket::bind(("127.0.0.1", port)).ok()?;
    Some(Reservation {
        ports: LocalPorts {
            socks: port,
            http: port + 1,
        },
        changed: port != original,
        _tcp: [socks, http],
        _udp: udp,
    })
}

// Only the application's two generated inbounds are rewritten. Native JSON stays under user control.
pub fn prepare(value: &mut Value, core: Core) -> Result<Reservation, String> {
    let field = match core {
        Core::Xray => "port",
        Core::SingBox => "listen_port",
    };
    let inbounds = value["inbounds"].as_array_mut().ok_or("默认配置缺少入站")?;
    let index = |tag: &str| {
        inbounds
            .iter()
            .position(|i| i["tag"] == tag && i["listen"] == "127.0.0.1")
    };
    let socks = index("socks-in").ok_or("默认配置缺少 SOCKS 入站")?;
    let http = index("http-in").ok_or("默认配置缺少 HTTP 入站")?;
    let original = inbounds[socks][field]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| (1024..65535).contains(p))
        .ok_or("本地端口无效")?;
    let mut reservation = None;
    for offset in 0..128u16 {
        if let Some(port) = original.checked_add(offset * 2) {
            reservation = reserve(port, original);
            if reservation.is_some() {
                break;
            }
        }
    }
    if reservation.is_none() {
        for _ in 0..64 {
            let probe =
                TcpListener::bind("127.0.0.1:0").map_err(|e| format!("无法选择本地端口：{e}"))?;
            let port = probe.local_addr().map_err(|e| e.to_string())?.port();
            drop(probe);
            reservation = reserve(port, original);
            if reservation.is_some() {
                break;
            }
        }
    }
    let reservation = reservation.ok_or("未找到空闲的本地代理端口，请检查系统端口保留设置")?;
    inbounds[socks][field] = reservation.ports.socks.into();
    inbounds[http][field] = reservation.ports.http.into();
    Ok(reservation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn occupied_tcp_or_udp_is_avoided_and_new_ports_remain_reserved() {
        for udp in [false, true] {
            let tcp = TcpListener::bind("127.0.0.1:0").unwrap();
            let original = tcp.local_addr().unwrap().port();
            if original == 65535 {
                continue;
            }
            let socket = UdpSocket::bind(("127.0.0.1", original)).unwrap();
            if udp {
                drop(tcp);
            }
            let mut value = json!({"inbounds":[
                {"tag":"socks-in","listen":"127.0.0.1","listen_port":original},
                {"tag":"http-in","listen":"127.0.0.1","listen_port":original+1}
            ],"outbounds":[{"type":"direct"}]});
            let lease = prepare(&mut value, Core::SingBox).unwrap();
            assert!(lease.changed);
            assert_ne!(lease.ports.socks, original);
            assert_eq!(lease.ports.http, lease.ports.socks + 1);
            assert!(TcpListener::bind(("127.0.0.1", lease.ports.http)).is_err());
            assert!(UdpSocket::bind(("127.0.0.1", lease.ports.socks)).is_err());
            assert_eq!(value["outbounds"], json!([{"type":"direct"}]));
            drop(socket);
        }
    }
}
