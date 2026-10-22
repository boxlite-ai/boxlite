use anyhow::{Result, anyhow};
use boxlite::runtime::options::{InboundNetworkConfig, NetworkMode, OutboundNetworkConfig};
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct InboundArgs {
    /// Box ID or name.
    #[arg(value_name = "BOX")]
    pub target: String,
    /// Access mode: enabled or disabled.
    #[arg(value_name = "MODE", value_parser = ["enabled", "disabled"])]
    pub mode: String,
}

#[derive(Args, Debug)]
pub struct OutboundArgs {
    #[command(flatten)]
    pub access: InboundArgs,
    /// Allow one hostname, wildcard, IPv4 or IPv4 CIDR. Repeat for multiple rules.
    /// Omit or pass a single empty string to use the default empty allowlist.
    #[arg(long, value_name = "RULE")]
    pub allow_net: Vec<String>,
}

/// A lone `--allow-net ''` spells the empty allowlist; any other list is kept
/// as given so validation can reject an empty rule mixed with real ones.
pub(crate) fn allow_net_rules(rules: &[String]) -> Vec<String> {
    match rules {
        [rule] if rule.is_empty() => Vec::new(),
        rules => rules.to_vec(),
    }
}

impl OutboundArgs {
    fn config(&self) -> Result<OutboundNetworkConfig> {
        let config = OutboundNetworkConfig {
            mode: self.access.mode.parse::<NetworkMode>()?,
            allow_net: allow_net_rules(&self.allow_net),
        };
        config.validate()?;
        Ok(config)
    }
}

pub async fn set_inbound(args: InboundArgs, global: &GlobalFlags) -> Result<()> {
    let config = InboundNetworkConfig {
        mode: args.mode.parse()?,
        allow_net: Vec::new(),
    };
    let runtime = global.create_runtime()?;
    let handle = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;
    handle.network().update_inbound(config).await?;
    Ok(())
}

pub async fn set_outbound(args: OutboundArgs, global: &GlobalFlags) -> Result<()> {
    let config = args.config()?;
    let runtime = global.create_runtime()?;
    let handle = runtime
        .get(&args.access.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.access.target))?;
    handle.network().update_outbound(config).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::cli::{Cli, Commands};
    use crate::commands::network::NetworkCommand;
    use clap::Parser;

    #[test]
    fn network_policy_accepts_explicit_empty_allowlist() {
        let cli = Cli::try_parse_from([
            "boxlite",
            "network",
            "outbound",
            "box",
            "enabled",
            "--allow-net",
            "",
        ])
        .unwrap();
        let Commands::Network(args) = cli.command else {
            panic!("network command")
        };
        let NetworkCommand::Outbound(args) = args.command else {
            panic!("outbound command")
        };
        let config = args
            .config()
            .expect("an explicit empty argument clears rules");
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::json!({"mode": "enabled", "allow_net": []})
        );
    }

    #[test]
    fn network_policy_requires_box_mode_and_direction_specific_flags() {
        for args in [
            vec!["boxlite", "network", "inbound"],
            vec!["boxlite", "network", "inbound", "box"],
            vec!["boxlite", "network", "outbound", "box"],
            vec!["boxlite", "network", "outbound", "box", "on"],
            vec![
                "boxlite",
                "network",
                "inbound",
                "box",
                "enabled",
                "--allow-net",
                "example.com",
            ],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn network_policy_replaces_allowlist_and_rejects_conflicts() {
        let parse = |tail: &[&str]| {
            let mut args = vec!["boxlite", "network", "outbound", "box"];
            args.extend_from_slice(tail);
            let cli = Cli::try_parse_from(args).unwrap();
            let Commands::Network(args) = cli.command else {
                panic!("network command")
            };
            let NetworkCommand::Outbound(args) = args.command else {
                panic!("outbound")
            };
            args.config()
        };
        let config = parse(&[
            "enabled",
            "--allow-net",
            "*.example.com",
            "--allow-net",
            "10.0.0.0/8",
        ])
        .unwrap();
        assert_eq!(config.allow_net, ["*.example.com", "10.0.0.0/8"]);
        assert_eq!(
            serde_json::to_value(parse(&["enabled"]).unwrap()).unwrap(),
            serde_json::json!({"mode": "enabled", "allow_net": []})
        );
        let disabled = parse(&["disabled"]).unwrap();
        assert_eq!(
            serde_json::to_value(disabled).unwrap(),
            serde_json::json!({"mode": "disabled", "allow_net": []})
        );
        for args in [
            vec!["disabled", "--allow-net", "example.com"],
            vec!["enabled", "--allow-net", "", "--allow-net", "example.com"],
            vec!["enabled", "--allow-net", "example.com", "--allow-net", ""],
            vec!["enabled", "--allow-net", "", "--allow-net", ""],
            vec!["enabled", "--allow-net", "a.com,b.com"],
            vec!["enabled", "--allow-net", "10.0.0.0/33"],
        ] {
            assert!(parse(&args).is_err());
        }
    }
}
