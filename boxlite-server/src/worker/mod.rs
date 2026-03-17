//! Worker role — runs BoxliteRuntime and exposes gRPC WorkerService.

pub mod service;

use boxlite::{BoxliteOptions, BoxliteRuntime};

use crate::proto::worker_service_server::WorkerServiceServer;
use crate::worker::service::WorkerServiceImpl;

/// Register this worker with the coordinator via REST.
async fn register_with_coordinator(
    coordinator_url: &str,
    worker_url: &str,
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{coordinator_url}/v1/admin/workers"))
        .json(&serde_json::json!({
            "url": worker_url,
            "capacity": {
                "max_boxes": 100,
                "available_cpus": 4,
                "available_memory_mib": 8192,
                "running_boxes": 0
            }
        }))
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Failed to register with coordinator: {text}");
    }

    let body: serde_json::Value = resp.json().await?;
    let worker_id = body["worker_id"].as_str().unwrap_or("unknown").to_string();
    Ok(worker_id)
}

/// Start the worker: BoxliteRuntime + gRPC server + coordinator registration.
pub async fn serve(
    host: &str,
    port: u16,
    coordinator_url: &str,
    home: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let mut options = BoxliteOptions::default();
    if let Some(home_dir) = home {
        options.home_dir = home_dir;
    }
    let runtime = BoxliteRuntime::new(options)?;
    let worker_svc = WorkerServiceImpl::new(runtime);

    let addr = format!("{host}:{port}").parse()?;

    // Register with coordinator (use 127.0.0.1 if binding to 0.0.0.0)
    let register_host = if host == "0.0.0.0" { "127.0.0.1" } else { host };
    // gRPC URL uses http:// scheme
    let worker_url = format!("http://{register_host}:{port}");
    match register_with_coordinator(coordinator_url, &worker_url).await {
        Ok(worker_id) => {
            tracing::info!(worker_id = %worker_id, "Registered with coordinator");
            eprintln!("Registered with coordinator as {worker_id}");
        }
        Err(e) => {
            tracing::error!("Failed to register with coordinator: {e}");
            eprintln!("Warning: Failed to register with coordinator: {e}");
        }
    }

    tracing::info!("Worker gRPC server listening on {addr}");
    eprintln!("BoxLite worker (gRPC) listening on http://{addr}");

    tonic::transport::Server::builder()
        .add_service(WorkerServiceServer::new(worker_svc))
        .serve_with_shutdown(addr, async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("Worker shutting down...");
            eprintln!("\nShutting down...");
        })
        .await?;

    Ok(())
}
