//! Print active host-to-guest port bindings for a box.

use anyhow::{Result, anyhow};
use boxlite::runtime::options::PortSpec;
use clap::Args;

use super::format_port_mapping;
use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct PortArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,
}

pub async fn execute(args: PortArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let box_handle = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;
    let ports = box_handle.port_bindings().await?;
    print_port_bindings(&ports, &mut std::io::stdout().lock())
}

fn print_port_bindings(ports: &[PortSpec], writer: &mut dyn std::io::Write) -> Result<()> {
    for port in ports {
        writeln!(writer, "{}", format_port_mapping(port))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::runtime::options::PortProtocol;

    #[test]
    fn prints_one_resolved_binding_per_line() {
        let ports = vec![
            PortSpec {
                host_port: Some(49152),
                guest_port: 3000,
                protocol: PortProtocol::Tcp,
                host_ip: Some("127.0.0.1".to_string()),
            },
            PortSpec {
                host_port: Some(8080),
                guest_port: 80,
                protocol: PortProtocol::Tcp,
                host_ip: None,
            },
        ];
        let mut output = Vec::new();

        print_port_bindings(&ports, &mut output).unwrap();

        assert_eq!(
            String::from_utf8(output).unwrap(),
            "127.0.0.1:49152->3000/tcp\n0.0.0.0:8080->80/tcp\n"
        );
    }

    #[test]
    fn empty_bindings_print_nothing() {
        let mut output = Vec::new();
        print_port_bindings(&[], &mut output).unwrap();
        assert!(output.is_empty());
    }
}
