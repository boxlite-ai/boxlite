//! Worker role — runs BoxliteRuntime and exposes gRPC WorkerService.

pub mod service;

use boxlite::{BoxliteOptions, BoxliteRuntime};

use crate::proto::coordinator_service_client::CoordinatorServiceClient;
use crate::proto::worker_service_server::WorkerServiceServer;
use crate::proto::{RegisterWorkerRequest, WorkerCapacity as ProtoWorkerCapacity};
use crate::worker::service::WorkerServiceImpl;

/// Register this worker with the coordinator via gRPC.
async fn register_with_coordinator(
    coordinator_url: &str,
    worker_url: &str,
) -> anyhow::Result<String> {
    let mut client = CoordinatorServiceClient::connect(coordinator_url.to_string()).await?;

    let resp = client
        .register_worker(RegisterWorkerRequest {
            url: worker_url.to_string(),
            labels: Default::default(),
            capacity: Some(ProtoWorkerCapacity {
                max_boxes: 100,
                available_cpus: 4,
                available_memory_mib: 8192,
                running_boxes: 0,
            }),
        })
        .await?;

    let inner = resp.into_inner();
    Ok(inner.worker_id)
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
