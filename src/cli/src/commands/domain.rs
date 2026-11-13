//! `boxlite domain {bind,ls,unbind}` — the organization's domains.
//!
//! A domain is the organization's, not a box's: `bind` routes one to a box
//! port using its owned full hostname, `ls` shows every held domain with what it routes
//! to, unbound ones included, and `unbind` stops routing one while the
//! organization keeps it. Domains are a REST-runtime capability; the embedded
//! runtime answers "not supported".

use std::io::Write;

use anyhow::{Context, Result};
use boxlite::{Domain, DomainTarget};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;
use tabled::Tabled;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};

#[derive(Args, Debug)]
pub struct DomainArgs {
    #[command(subcommand)]
    pub command: DomainCommand,
}

#[derive(Subcommand, Debug)]
pub enum DomainCommand {
    /// Route an owned full hostname to a target; request names in Dashboard > Domains.
    Bind(BindArgs),

    /// List held domains; the table footer shows the allowance.
    #[command(visible_alias = "list")]
    Ls(LsArgs),

    /// Stop routing a domain; the organization keeps the name.
    Unbind(UnbindArgs),
}

#[derive(Args, Debug)]
pub struct BindArgs {
    /// An owned full hostname (`demo1.apps.example`); short names are rejected
    #[arg(value_name = "DOMAIN")]
    pub domain: String,

    /// The kind of resource the domain routes to
    #[arg(long = "type", value_enum, value_name = "TYPE")]
    pub target_type: BindTargetType,

    /// The box id or name; required for --type box
    #[arg(long = "box", value_name = "BOX", required_if_eq("target_type", "box"))]
    pub box_ref: Option<String>,

    /// The guest port inside the box; required for --type box
    #[arg(long, value_name = "PORT", required_if_eq("target_type", "box"), value_parser = clap::value_parser!(u16).range(1..))]
    pub port: Option<u16>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum BindTargetType {
    Box,
}

#[derive(Args, Debug)]
pub struct LsArgs {
    /// Only print full hostnames.
    #[arg(short, long, conflicts_with = "format")]
    pub quiet: bool,

    /// Output format (table, json, yaml).
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct UnbindArgs {
    /// The full hostname returned by domain ls (demo.apps.example)
    #[arg(value_name = "DOMAIN")]
    pub domain: String,
}

#[derive(Tabled, Serialize)]
pub struct DomainPresenter {
    #[tabled(rename = "HOSTNAME")]
    #[serde(rename = "Hostname")]
    pub hostname: String,
    #[tabled(rename = "URL")]
    #[serde(rename = "URL")]
    pub url: String,
    #[tabled(rename = "TARGET")]
    #[serde(rename = "Target")]
    pub target: String,
}

fn describe(target: Option<&DomainTarget>) -> String {
    match target {
        Some(DomainTarget::Box { box_ref, port }) => format!("box {box_ref}:{port}"),
        Some(DomainTarget::App { app_ref }) => format!("app {app_ref}"),
        // A target kind newer than this CLI (the enum is non-exhaustive).
        Some(other) => format!("{other:?}"),
        None => "-".to_string(),
    }
}

impl From<&Domain> for DomainPresenter {
    fn from(domain: &Domain) -> Self {
        Self {
            hostname: domain.hostname.clone(),
            url: domain.url.clone(),
            target: describe(domain.target.as_ref()),
        }
    }
}

pub async fn execute(args: DomainArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        DomainCommand::Bind(args) => bind(args, global).await,
        DomainCommand::Ls(args) => ls(args, global).await,
        DomainCommand::Unbind(args) => unbind(args, global).await,
    }
}

async fn bind(args: BindArgs, global: &GlobalFlags) -> Result<()> {
    let (target, destination) = match args.target_type {
        BindTargetType::Box => {
            let box_ref = args.box_ref.context("--box is required for --type box")?;
            let port = args.port.context("--port is required for --type box")?;
            let destination = format!("{box_ref}:{port}");
            (DomainTarget::Box { box_ref, port }, destination)
        }
    };
    let runtime = global.create_runtime()?;
    let domain = runtime.domains()?.bind(&args.domain, &target).await?;
    println!("{} → {destination}", domain.hostname);
    println!("{}", domain.url);
    Ok(())
}

async fn ls(args: LsArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let held = runtime.domains()?.list().await?;

    if args.quiet {
        for domain in &held.domains {
            println!("{}", domain.hostname);
        }
        return Ok(());
    }

    let presenters: Vec<DomainPresenter> = held.domains.iter().map(Into::into).collect();
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters,
        format,
        |writer, data| {
            let table = formatter::create_table(data).to_string();
            writeln!(writer, "{table}")?;
            writeln!(
                writer,
                "{} of {} platform names held ({} remaining); new platform names need at least {} characters",
                held.used, held.limit, held.remaining, held.min_length
            )?;
            Ok(())
        },
    )?;
    Ok(())
}

async fn unbind(args: UnbindArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    runtime.domains()?.unbind(&args.domain).await?;
    println!(
        "Released {}; the hostname stays with your organization",
        args.domain
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Commands, try_parse_from};

    fn domain_args(args: &[&str]) -> Result<DomainArgs, clap::Error> {
        let cli = try_parse_from(["boxlite", "domain"].iter().chain(args))?;
        let Commands::Domain(domain) = cli.command else {
            panic!("expected the domain command");
        };
        Ok(domain)
    }

    #[test]
    fn bind_takes_the_domain_and_an_explicit_box_target() {
        for (port, expected_port) in [("1", 1), ("3000", 3000), ("65535", 65535)] {
            let args = domain_args(&[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "--box",
                "web-a",
                "--port",
                port,
            ])
            .unwrap_or_else(|error| panic!("explicit Box target was rejected: {error}"));
            let DomainCommand::Bind(bind) = args.command else {
                panic!("expected bind");
            };
            assert_eq!(
                (bind.domain.as_str(), bind.box_ref.as_deref(), bind.port),
                ("demo1.apps.example", Some("web-a"), Some(expected_port))
            );
        }
    }

    #[test]
    fn bind_requires_the_selected_type_and_its_fields() {
        for args in [
            &[
                "bind",
                "demo1.apps.example",
                "--box",
                "web-a",
                "--port",
                "3000",
            ][..],
            &["bind", "demo1.apps.example", "--type", "app"][..],
            &["bind", "demo1.apps.example", "--type", "unknown"][..],
            &["bind", "demo1.apps.example", "--type", "box"][..],
            &[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "--box",
                "web-a",
            ][..],
            &[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "--port",
                "3000",
            ][..],
            &[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "--box",
                "web-a",
                "--port",
                "0",
            ][..],
            &[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "--box",
                "web-a",
                "--port",
                "65536",
            ][..],
            &[
                "bind",
                "demo1.apps.example",
                "--type",
                "box",
                "web-a",
                "3000",
            ][..],
        ] {
            assert!(domain_args(args).is_err(), "{args:?} was accepted");
        }
    }

    #[test]
    fn ls_accepts_its_list_alias_and_quiet_excludes_format() {
        assert!(matches!(
            domain_args(&["list"]).unwrap().command,
            DomainCommand::Ls(_)
        ));
        let err = domain_args(&["ls", "--quiet", "--format", "json"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::ArgumentConflict);
    }

    #[test]
    fn unbind_takes_the_domain_and_has_no_alias() {
        let args = domain_args(&["unbind", "demo.apps.example"]).unwrap();
        let DomainCommand::Unbind(unbind) = args.command else {
            panic!("expected unbind");
        };
        assert_eq!(unbind.domain, "demo.apps.example");
        assert!(domain_args(&["rm", "demo"]).is_err());
    }

    #[test]
    fn an_unbound_domain_shows_no_target() {
        let presenter = DomainPresenter::from(&Domain {
            hostname: "spare.app.test".into(),
            url: "https://spare.app.test".into(),
            target: None,
        });
        assert_eq!(presenter.target, "-");
        assert_eq!(presenter.hostname, "spare.app.test");
        let bound = describe(Some(&DomainTarget::Box {
            box_ref: "AbCdEf123456".into(),
            port: 3000,
        }));
        assert_eq!(bound, "box AbCdEf123456:3000");
    }
}
