//! Run one OpenCode 2.2 agent turn inside a Box and stream its text.
//!
//! BoxLite does not install agents yet, so point `OPENCODE_BINARY` at the glibc
//! Linux release build for this machine's architecture. The provider key
//! reaches OpenCode's managed service through the Box environment:
//!
//! ```sh
//! gh release download v2.2.2 --repo anomalyco/opencode --pattern 'opencode-linux-arm64.tar.gz'
//! tar -xzf opencode-linux-arm64.tar.gz
//! OPENCODE_BINARY=$PWD/opencode OPENCODE_MODEL=anthropic/claude-sonnet-4-5 ANTHROPIC_API_KEY=... \
//!   cargo run -p boxlite --features krun,gvproxy --example agent_opencode
//! ```
//!
//! For another provider, such as a local OpenAI-compatible server, put its
//! OpenCode configuration in `OPENCODE_CONFIG_CONTENT`; the Box reaches the
//! host as `host.boxlite.internal`.

use boxlite::agents::{AgentCreateOptions, AgentEventsOptions, AgentSendOptions, AgentWaitOptions};
use boxlite::runtime::options::{BoxOptions, RootfsSpec};
use boxlite::{BoxCommand, BoxliteRuntime, CopyOptions};
use futures::StreamExt;
use std::io::Write;

/// Provider keys and inline OpenCode configuration, forwarded into the Box
/// when set on the host.
const FORWARDED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENCODE_CONFIG_CONTENT",
];

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let binary = std::env::var("OPENCODE_BINARY").map_err(|_| "set OPENCODE_BINARY")?;
    let model = std::env::var("OPENCODE_MODEL")
        .map_err(|_| "set OPENCODE_MODEL, e.g. anthropic/claude-sonnet-4-5")?;
    let env = FORWARDED_ENV
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| (key.to_string(), value))
        })
        .collect();

    let runtime = BoxliteRuntime::new(Default::default())?;
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("debian:bookworm-slim".into()),
                env,
                ..Default::default()
            },
            None,
        )
        .await?;
    sandbox.start().await?;
    sandbox
        .copy_into(&binary, "/usr/local/bin/opencode", CopyOptions::default())
        .await?;
    sandbox
        .exec(BoxCommand::new("chmod").args(["755", "/usr/local/bin/opencode"]))
        .await?
        .wait()
        .await?;

    let mut options = AgentCreateOptions::default();
    options.config.model = Some(model);
    let agent = sandbox.agents().create("opencode", options).await?;
    let mut events = agent.events(AgentEventsOptions::default()).await?;
    let turn = agent
        .send(
            "Write a haiku about sandboxes.",
            AgentSendOptions::default(),
        )
        .await?;
    tokio::spawn(async move {
        while let Some(Ok(event)) = events.next().await {
            if event.kind == "session.text.delta" {
                print!(
                    "{}",
                    event.data["data"]["delta"].as_str().unwrap_or_default()
                );
                let _ = std::io::stdout().flush();
            }
        }
    });
    let result = turn.wait(AgentWaitOptions::default()).await?;
    println!(
        "\n[{:?}] {}",
        result.status,
        result.text.unwrap_or_default()
    );

    runtime.shutdown(None).await?;
    Ok(())
}
