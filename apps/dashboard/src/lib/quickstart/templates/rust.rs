use boxlite::{BoxCommand, BoxOptions, BoxliteRestOptions, BoxliteRuntime, NetworkSpec, RootfsSpec, TunnelOptions};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_url = std::env::var("BOXLITE_REST_URL").unwrap_or_else(|_| "{{REST_API_URL}}".to_owned());
    let rt = BoxliteRuntime::rest(BoxliteRestOptions::new(api_url).with_api_key({{API_KEY_RS}}))?;
    let options = BoxOptions {
    rootfs: RootfsSpec::Image("ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0".into()),
    inbound_network: NetworkSpec::default(),
    ..Default::default()
    };
    let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
    let box_handle = rt.create(options, Some(format!("sdk-quickstart-rust-{suffix}"))).await?;
    println!("Created Box: {}", box_handle.id());
    box_handle.start().await?;
{{STEP_EXECUTION}}
    let mut exec = box_handle.exec(BoxCommand::new({{COMMAND_LITERAL}}){{RUST_ARGUMENTS}}).await?;
    let mut stdout = exec.stdout().ok_or("Missing stdout stream")?;
    while let Some(line) = stdout.next().await { print!("{line}"); }
    let result = exec.wait().await?;
    if result.exit_code != 0 { return Err(format!("Command exited with {}", result.exit_code).into()); }
{{STEP_PREVIEW}}
    let server_code = {{SERVER_RS}};
    let _server = box_handle.exec(BoxCommand::new("python3").args(["-u", "-c", server_code])).await?;
    // Address the preview server inside the guest.
    let target = format!("{}:3000", boxlite::net::constants::GUEST_IP).parse()?;
    let preview = box_handle.network().tunnel(target, TunnelOptions::default()).await?;
    let url = preview.uri().ok_or("Cloud did not return a preview URL")?;
    println!("Preview URL: {url}");
    Ok(())
}
