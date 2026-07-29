// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

use boxlite_proxy::{config, telemetry};

// Deliberately not `#[tokio::main]`. Telemetry has to be installed before
// anything logs, and its exporters run on batch-processor threads that have no
// Tokio reactor — which is why they use a blocking HTTP client. Building
// telemetry first and the runtime second keeps that ordering explicit.
fn main() {
    // Before any TLS client is constructed, including the OTLP exporter's: it
    // uses rustls without a bundled provider and reads the process default.
    boxlite_proxy::install_crypto_provider();

    // Telemetry reads the environment, so the `.env` files have to be applied
    // first — `Config::from_env` is too late. Any failure is reported back
    // rather than logged, because there is no subscriber yet.
    let env_file_problems = config::load_env_files();

    let telemetry = telemetry::init(&telemetry::Config::from_env(), config::VERSION);

    for problem in env_file_problems {
        tracing::warn!(problem, "failed to load env file");
    }

    let exit_code = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let outcome = runtime.block_on(boxlite_proxy::run());

            if let Err(err) = &outcome {
                tracing::error!(error = %err, "proxy exited with an error");
            } else {
                tracing::info!("proxy exited gracefully");
            }

            // Shut the runtime down before flushing, so nothing is still
            // emitting into an exporter that is on its way out.
            drop(runtime);
            i32::from(outcome.is_err())
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to start the async runtime");
            1
        }
    };

    // Runs on every path, including the failure ones: a batch exporter drops
    // whatever is still queued when the process ends.
    telemetry.shutdown();

    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
