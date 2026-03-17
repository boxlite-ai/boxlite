//! BoxLite distributed server entry point.
//!
//! Usage:
//!   boxlite-server coordinator --port 8200
//!   boxlite-server worker --coordinator http://coordinator:8200 --grpc-port 9100

use std::path::PathBuf;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "boxlite-server", version, about = "BoxLite distributed server")]
struct Cli {
    /// Enable debug output
    #[arg(long, global = true)]
    debug: bool,

    #[command(subcommand)]
    role: Role,
}

#[derive(Subcommand)]
enum Role {
    /// Run as coordinator (accepts client REST requests, dispatches to workers)
    Coordinator(CoordinatorArgs),

    /// Run as worker (executes boxes, reports to coordinator)
    Worker(WorkerArgs),
}

#[derive(clap::Args)]
struct CoordinatorArgs {
    /// Port for the REST API
    #[arg(long, default_value = "8200", env = "BOXLITE_COORDINATOR_PORT")]
    port: u16,

    /// Host/address to bind to
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Path to the coordinator SQLite database
    #[arg(
        long,
        default_value = "~/.boxlite/coordinator.db",
        env = "BOXLITE_COORDINATOR_DB"
    )]
    db_path: String,
}

#[derive(clap::Args)]
struct WorkerArgs {
    /// Coordinator URL for registration
    #[arg(long, env = "BOXLITE_COORDINATOR_URL")]
    coordinator: String,

    /// Port for the worker REST API
    #[arg(long, default_value = "9100", env = "BOXLITE_WORKER_PORT")]
    port: u16,

    /// Host/address to bind to
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Worker name (defaults to hostname)
    #[arg(long, env = "BOXLITE_WORKER_NAME")]
    name: Option<String>,

    /// BoxLite home directory
    #[arg(long, env = "BOXLITE_HOME")]
    home: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Initialize tracing
    let filter = if cli.debug { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(filter)),
        )
        .init();

    match cli.role {
        Role::Coordinator(args) => {
            let db_path = expand_tilde(&args.db_path);
            let store = boxlite_server::store::sqlite::SqliteStateStore::open(
                std::path::Path::new(&db_path),
            )?;
            boxlite_server::coordinator::serve(&args.host, args.port, store).await
        }
        Role::Worker(args) => {
            boxlite_server::worker::serve(&args.host, args.port, &args.coordinator, args.home).await
        }
    }
}

/// Expand ~ to home directory.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest).to_string_lossy().to_string();
    }
    path.to_string()
}
