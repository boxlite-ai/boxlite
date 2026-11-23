//! Manage organization proxy registrations and Box bindings.

use std::io::{self, IsTerminal, Read};

use anyhow::{Result, bail};
use boxlite::{ProxyCredential, ProxyCredentialChange, ProxyMutation, ProxyMutationState};
use clap::{Args, Subcommand};
use serde::Deserialize;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct OutboundProxyArgs {
    #[command(subcommand)]
    command: OutboundProxyCommand,
}

#[derive(Subcommand, Debug)]
enum OutboundProxyCommand {
    /// List organization registrations.
    List,
    /// Inspect one registration without revealing its credentials.
    Get { name: String },
    /// Register a proxy endpoint.
    Create {
        name: String,
        #[arg(value_name = "ENDPOINT")]
        endpoint: String,
        /// Read a JSON object with username and password from redirected stdin.
        #[arg(long)]
        credential_stdin: bool,
    },
    /// Update a registration. An omitted credential keeps the existing value.
    Update {
        name: String,
        #[arg(long, value_name = "URL")]
        endpoint: Option<String>,
        /// Read a replacement credential from redirected stdin.
        #[arg(long, conflicts_with = "clear_credential")]
        credential_stdin: bool,
        /// Remove the current credential.
        #[arg(long)]
        clear_credential: bool,
    },
    /// Delete an unused registration.
    Delete { name: String },
    /// Bind a registration to a running Cloud Box.
    Bind { box_id: String, name: String },
    /// Request release of the current Box binding.
    Unbind { box_id: String },
    /// Read desired, committed and installed binding state.
    Status { box_id: String },
}

fn read_credential() -> Result<ProxyCredential> {
    const LIMIT: usize = 4096;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CredentialInput {
        username: String,
        password: String,
    }

    let stdin = io::stdin();
    if stdin.is_terminal() {
        bail!("redirect a credential JSON file to stdin");
    }
    let mut body = Vec::new();
    stdin
        .lock()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut body)?;
    if body.len() > LIMIT {
        bail!("credential JSON exceeds {LIMIT} bytes");
    }
    let CredentialInput { username, password } = serde_json::from_slice(&body)
        .map_err(|_| anyhow::anyhow!("expected a JSON object with username and password"))?;
    Ok(ProxyCredential::new(username, password)?)
}

fn report(result: ProxyMutation) -> Result<()> {
    let revision = result
        .revision
        .as_ref()
        .map_or(String::new(), |rev| format!(" (revision {rev})"));
    match result.state {
        ProxyMutationState::Accepted => println!("accepted{revision}"),
        ProxyMutationState::AcceptedReleaseUnconfirmed => {
            println!("accepted, release unconfirmed{revision}")
        }
        ProxyMutationState::Rejected => {
            bail!("proxy change rejected (HTTP {:?})", result.http_status)
        }
        ProxyMutationState::Unknown => bail!(
            "proxy change outcome unknown (HTTP {:?}); inspect the current registry or Box status before another write",
            result.http_status
        ),
    }
    Ok(())
}

pub async fn execute(args: OutboundProxyArgs, global: &GlobalFlags) -> Result<()> {
    use OutboundProxyCommand::*;
    if !global.targets_rest()? {
        bail!("outbound proxy commands require a BoxLite Cloud context");
    }
    let runtime = global.create_runtime()?;
    match args.command {
        List => println!(
            "{}",
            serde_json::to_string_pretty(&runtime.outbound_proxies()?.list().await?)?
        ),
        Get { name } => println!(
            "{}",
            serde_json::to_string_pretty(&runtime.outbound_proxies()?.get(&name).await?)?
        ),
        Create {
            name,
            endpoint,
            credential_stdin,
        } => {
            let registry = runtime.outbound_proxies()?;
            let credential = credential_stdin.then(read_credential).transpose()?;
            report(
                registry
                    .create(&name, &endpoint, credential.as_ref())
                    .await?,
            )?;
        }
        Update {
            name,
            endpoint,
            credential_stdin,
            clear_credential,
        } => {
            let registry = runtime.outbound_proxies()?;
            let credential = if credential_stdin {
                ProxyCredentialChange::Set(read_credential()?)
            } else if clear_credential {
                ProxyCredentialChange::Clear
            } else {
                ProxyCredentialChange::Keep
            };
            report(
                registry
                    .update(&name, endpoint.as_deref(), credential)
                    .await?,
            )?;
        }
        Delete { name } => report(runtime.outbound_proxies()?.remove(&name).await?)?,
        Bind { box_id, name } => {
            let box_handle = runtime
                .get(&box_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Box not found"))?;
            report(box_handle.network().set_managed_proxy(Some(&name)).await?)?;
        }
        Unbind { box_id } => {
            let box_handle = runtime
                .get(&box_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Box not found"))?;
            report(box_handle.network().set_managed_proxy(None).await?)?;
        }
        Status { box_id } => {
            let box_handle = runtime
                .get(&box_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("Box not found"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&box_handle.network().managed_proxy_status().await?)?
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use assert_cmd::Command;
    use axum::{
        Json, Router,
        http::StatusCode,
        routing::{get, post},
    };
    use serde_json::{Value, json};

    use crate::ssh_cloud_fixture::{cli_executable, isolated};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn managed_proxy_cli_uses_structured_create_and_unbind_outcomes() {
        let app = Router::new()
            .route("/v1/config", get(async || Json(json!({"capabilities":{"outbound_proxy_registry_enabled":true}}))))
            .route("/v1/boxes", post(async |Json(body): Json<Value>| {
                assert_eq!(body.pointer("/network/outbound/proxy"), Some(&json!("outbound")));
                (StatusCode::REQUEST_TIMEOUT, Json(json!({"code":"outbound_create_admitted","boxId":"existing-box"})))
            }))
            .route("/v1/boxes/box1", get(async || Json(json!({
                "box_id":"box1", "status":"running", "created_at":"2026-07-14T00:00:00Z", "updated_at":"2026-07-14T00:00:00Z",
                "image":"alpine", "cpus":1, "memory_mib":256,
            }))))
            .route("/v1/boxes/box1/network/outbound", get(async || (
                [("etag", "\"rev-a\"")], Json(json!({"mode":"enabled","allow_net":["example.org"],"proxy":"outbound"})),
            )).put(async |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                assert_eq!(headers["if-match"], "\"rev-a\"");
                assert_eq!(body, json!({"mode":"enabled","allow_net":["example.org"],"proxy":null}));
                [("etag", "\"rev-b\"")]
            }))
            .route("/v1/boxes/box1/network/outbound/status", get(async || StatusCode::SERVICE_UNAVAILABLE));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let home = tempfile::tempdir().unwrap();

        let mut create = Command::new(cli_executable());
        isolated(&mut create, home.path());
        create
            .args([
                "--url",
                &url,
                "create",
                "--outbound-proxy",
                "outbound",
                "alpine",
            ])
            .assert()
            .failure()
            .stderr(predicates::str::contains("existing-box"));

        let mut unbind = Command::new(cli_executable());
        isolated(&mut unbind, home.path());
        unbind
            .args(["--url", &url, "outbound-proxy", "unbind", "box1"])
            .assert()
            .success()
            .stdout("accepted, release unconfirmed (revision rev-b)\n");

        let mut credential = Command::new(cli_executable());
        isolated(&mut credential, home.path());
        credential
            .args([
                "--url",
                &url,
                "outbound-proxy",
                "create",
                "outbound",
                "https://proxy.example",
                "--credential-stdin",
            ])
            .write_stdin(r#"{"username":"example-user","password":"example-token"}"#)
            .assert()
            .failure()
            .stderr(predicates::str::contains("require an HTTPS URL"));
        server.abort();
    }
}
