pub mod auth;
pub mod cp;
pub mod create;
pub mod exec;
pub mod images;
pub mod info;
pub mod inspect;
pub mod list;
pub mod logs;
pub mod port;
pub mod pull;
pub mod restart;
pub mod rm;
pub mod run;
pub mod serve;
pub mod start;
pub mod stats;
pub mod stop;
pub mod tunnel;
pub mod volume;

pub(crate) fn format_port_mapping(port: &boxlite::runtime::options::PortSpec) -> String {
    let host_ip = port.host_ip.as_deref().unwrap_or("0.0.0.0");
    let host_port = port
        .host_port
        .map(|port| port.to_string())
        .unwrap_or_else(|| "?".to_string());
    let protocol = match port.protocol {
        boxlite::runtime::options::PortProtocol::Tcp => "tcp",
        boxlite::runtime::options::PortProtocol::Udp => "udp",
    };
    format!("{host_ip}:{host_port}->{}/{protocol}", port.guest_port)
}

pub(crate) fn format_ports(ports: &[boxlite::runtime::options::PortSpec]) -> String {
    ports
        .iter()
        .map(format_port_mapping)
        .collect::<Vec<_>>()
        .join(", ")
}

fn resolved_port_messages(ports: &[boxlite::runtime::options::PortSpec]) -> Vec<String> {
    ports
        .iter()
        .filter(|port| port.host_port.is_some())
        .map(format_port_mapping)
        .collect()
}

pub(crate) fn print_resolved_ports(litebox: &boxlite::LiteBox) {
    for mapping in resolved_port_messages(&litebox.info().ports) {
        eprintln!("Port {mapping}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::runtime::options::{PortProtocol, PortSpec};

    #[test]
    fn resolved_port_messages_include_only_resolved_mappings() {
        let ports = vec![
            PortSpec {
                host_port: Some(49152),
                guest_port: 3000,
                protocol: PortProtocol::Tcp,
                host_ip: Some("127.0.0.1".to_string()),
            },
            PortSpec {
                host_port: None,
                guest_port: 8080,
                protocol: PortProtocol::Tcp,
                host_ip: None,
            },
        ];

        assert_eq!(
            resolved_port_messages(&ports),
            vec!["127.0.0.1:49152->3000/tcp"]
        );
    }
}
