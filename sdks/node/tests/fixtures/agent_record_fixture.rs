#[path = "../../src/agents.rs"]
mod agents;
#[path = "../../src/util.rs"]
mod util;

use agents::{JsAgent, JsAgents};
use boxlite::{BoxOptions, BoxliteOptions, BoxliteRuntime, RootfsSpec};
use napi_derive::napi;

/// Seed the backend on the Rust side, before JavaScript can round the token.
#[napi]
pub async fn seed_agent(home: String, token: String) -> napi::Result<JsAgent> {
    let runtime = BoxliteRuntime::new_for_test(BoxliteOptions {
        home_dir: home.into(),
        ..Default::default()
    })
    .map_err(util::map_err)?;
    let sandbox = runtime
        .create(
            BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        )
        .await
        .map_err(util::map_err)?;
    let agent = JsAgents::from_core(sandbox.agents().with_test_backend())
        .create("test".into(), None)
        .await?;
    let data: serde_json::Value =
        serde_json::from_str(&token).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    agent
        .send("echo".into(), Some(serde_json::json!({"data":data})))
        .await?;
    Ok(agent)
}
