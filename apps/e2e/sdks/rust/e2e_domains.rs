//! REST acceptance driver invoked by apps/e2e/cases/test_subdomain.py.
use boxlite::{BoxliteRestOptions, BoxliteRuntime, Domain, DomainTarget};
use serde_json::{Value, json};
use std::{env, error::Error};

fn domain(d: &Domain) -> Value {
    json!({"hostname": d.hostname, "url": d.url, "target": d.target})
}

const USAGE: &str = "usage: domain-rust list | unbind <domain> | bind <domain> <port>";

enum Action<'a> {
    List,
    Unbind(&'a str),
    Bind { domain: &'a str, port: u16 },
}

impl<'a> Action<'a> {
    fn parse(args: &'a [String]) -> Result<Self, &'static str> {
        match args {
            [action] if action == "list" => Ok(Self::List),
            [action, domain] if action == "unbind" => Ok(Self::Unbind(domain)),
            [action, domain, port] if action == "bind" => Ok(Self::Bind {
                domain,
                port: port.parse().map_err(|_| USAGE)?,
            }),
            _ => Err(USAGE),
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let action = Action::parse(&args)?;
    let runtime = BoxliteRuntime::rest(
        BoxliteRestOptions::new(env::var("BOXLITE_E2E_URL")?)
            .with_api_key(env::var("BOXLITE_E2E_API_KEY")?)
            .with_path_prefix(env::var("BOXLITE_E2E_PREFIX")?),
    )?;
    let domains = runtime.domains()?;
    let result = match action {
        Action::List => {
            let held = domains.list().await?;
            json!({"domains": held.domains.iter().map(domain).collect::<Vec<_>>(),
                "limit": held.limit, "used": held.used, "remaining": held.remaining,
                "min_length": held.min_length})
        }
        Action::Unbind(hostname) => {
            domains.unbind(hostname).await?;
            json!({})
        }
        Action::Bind {
            domain: hostname,
            port,
        } => {
            let target = DomainTarget::Box {
                box_ref: env::var("BOXLITE_E2E_BOX")?,
                port,
            };
            domain(&domains.bind(hostname, &target).await?)
        }
    };
    println!("{result}");
    Ok(())
}
