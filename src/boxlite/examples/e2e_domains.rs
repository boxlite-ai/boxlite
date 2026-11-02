//! REST acceptance driver invoked by apps/e2e/cases/test_subdomain.py.
use boxlite::{BoxliteRestOptions, BoxliteRuntime, Domain, DomainTarget};
use serde_json::{Value, json};
use std::{env, error::Error};

fn domain(d: &Domain) -> Value {
    json!({"hostname": d.hostname, "url": d.url, "target": d.target})
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let runtime = BoxliteRuntime::rest(
        BoxliteRestOptions::new(env::var("BOXLITE_E2E_URL")?)
            .with_api_key(env::var("BOXLITE_E2E_API_KEY")?)
            .with_path_prefix(env::var("BOXLITE_E2E_PREFIX")?),
    )?;
    let domains = runtime.domains()?;
    let args: Vec<String> = env::args().collect();
    let result = match args[1].as_str() {
        "list" => {
            let held = domains.list().await?;
            json!({"domains": held.domains.iter().map(domain).collect::<Vec<_>>(),
                "limit": held.limit, "used": held.used, "remaining": held.remaining,
                "min_length": held.min_length})
        }
        "unbind" => {
            domains.unbind(&args[2]).await?;
            json!({})
        }
        "bind" => {
            let target = DomainTarget::Box {
                box_ref: env::var("BOXLITE_E2E_BOX")?,
                port: args[3].parse()?,
            };
            domain(&domains.bind(&args[2], &target).await?)
        }
        _ => return Err("unknown operation".into()),
    };
    println!("{result}");
    Ok(())
}
