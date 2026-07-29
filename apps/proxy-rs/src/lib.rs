// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! BoxLite preview proxy.
//!
//! Routes `<port>-<boxId | signedToken>.<domain>` to a port inside a box,
//! authenticating the caller and keeping the box awake while they use it.

pub mod api;
pub mod body;
pub mod cache;
pub mod config;
pub mod cors;
pub mod error;
pub mod proxy;
pub mod response;
pub mod retry;
pub mod server;
pub mod signed_cookie;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use config::Config;
use proxy::Proxy;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Starts the proxy and serves until shutdown.
pub async fn run() -> Result<(), Error> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "failed to install the rustls crypto provider")?;

    let mut config = Config::from_env()?;
    tracing::info!(
        version = config::VERSION,
        api = %config.boxlite_api_url,
        "starting BoxLite proxy"
    );

    // The control plane is the source of truth for OIDC settings the deployment
    // did not pin, and it may still be coming up, so this is retried.
    let api = api::ApiClient::new(&config.boxlite_api_url, &config.proxy_api_key)?;
    let discovered = retry::with_backoff(retry::STARTUP, "get BoxLite API config", || {
        api.get_oidc_config()
    })
    .await?;
    config.apply_discovered_oidc(discovered);

    let proxy: Arc<Proxy> = Proxy::new(config).await?;
    let shutdown = {
        let config = proxy.config().clone();
        async move { server::shutdown_signal(&config).await }
    };

    server::serve(proxy, shutdown).await?;
    Ok(())
}
