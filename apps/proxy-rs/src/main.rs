// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    if let Err(err) = boxlite_proxy::run().await {
        tracing::error!(error = %err, "proxy exited with an error");
        std::process::exit(1);
    }

    tracing::info!("proxy exited gracefully");
}
