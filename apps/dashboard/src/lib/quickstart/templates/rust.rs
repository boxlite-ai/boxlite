use boxlite::{BoxCommand, BoxOptions, BoxliteRestOptions, BoxliteRuntime, RootfsSpec};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = {{API_KEY_RS}};
    let api_url = std::env::var("BOXLITE_REST_URL").unwrap_or_else(|_| "{{REST_API_URL}}".to_owned());
    let rt = BoxliteRuntime::rest(
        BoxliteRestOptions::new(api_url).with_api_key(api_key),
    )?;

    let options = BoxOptions {
        rootfs: RootfsSpec::Image(
            "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3".into(),
        ),
        ..Default::default()
    };
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let name = format!("sdk-quickstart-rust-{suffix}");
    let box_handle = rt.create(options, Some(name)).await?;
    box_handle.start().await?;

    let mut exec = box_handle
        .exec(BoxCommand::new("echo").arg("Hello from BoxLite SDK"))
        .await?;
    let mut stdout = exec.stdout().expect("stdout stream should be available");
    let mut output = String::new();
    while let Some(line) = stdout.next().await {
        output.push_str(&line);
    }
    let result = exec.wait().await?;
    println!("Exit code: {}", result.exit_code);
    print!("{output}");

    rt.remove(&box_handle.id().to_string(), true).await?;
    Ok(())
}
