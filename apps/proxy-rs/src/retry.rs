// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Exponential-backoff retry for BoxLite API calls.

use std::future::Future;
use std::time::Duration;

use crate::error::Result;

#[derive(Debug, Clone, Copy)]
pub struct Policy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

/// Per-request API lookups: a client is waiting, so give up quickly.
pub const REQUEST: Policy = Policy {
    max_attempts: 3,
    base_delay: Duration::from_millis(150),
    max_delay: Duration::from_secs(1),
};

/// Startup bootstrap: nothing is serving yet, so wait out a slow control plane.
pub const STARTUP: Policy = Policy {
    max_attempts: 10,
    base_delay: Duration::from_secs(1),
    max_delay: Duration::from_secs(60),
};

/// Retries `operation` while it keeps failing retryably, doubling the delay each
/// time. Non-retryable failures return immediately — a 404 will not become a 200.
pub async fn with_backoff<T, F, Fut>(policy: Policy, name: &str, mut operation: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut last_error = None;

    for attempt in 0..policy.max_attempts {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(err) if !err.is_retryable() => return Err(err),
            Err(err) => {
                if attempt + 1 < policy.max_attempts {
                    let delay = policy
                        .base_delay
                        .saturating_mul(1 << attempt.min(31))
                        .min(policy.max_delay);
                    tracing::warn!(
                        operation = name,
                        attempt = attempt + 1,
                        max_attempts = policy.max_attempts,
                        error = %err,
                        retry_delay_ms = delay.as_millis(),
                        "operation failed, retrying"
                    );
                    tokio::time::sleep(delay).await;
                }
                last_error = Some(err);
            }
        }
    }

    Err(last_error
        .expect("the loop only exits without a value after recording a failure")
        .with_operation(name, policy.max_attempts))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use crate::error::ProxyError;
    use http::StatusCode;

    use super::*;

    fn upstream(status: StatusCode) -> ProxyError {
        ProxyError::Upstream {
            status,
            message: "boom".into(),
            code: "BOOM".into(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn retries_until_success() {
        let attempts = AtomicU32::new(0);

        let result = with_backoff(REQUEST, "flaky", || async {
            if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                Err(upstream(StatusCode::BAD_GATEWAY))
            } else {
                Ok("ok")
            }
        })
        .await;

        assert_eq!(result.expect("succeeds on the third attempt"), "ok");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_retry_client_errors() {
        let attempts = AtomicU32::new(0);

        let result: Result<()> = with_backoff(REQUEST, "forbidden", || async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(upstream(StatusCode::FORBIDDEN))
        })
        .await;

        assert_eq!(
            result.expect_err("stays an error").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_after_max_retries_and_names_the_operation() {
        let attempts = AtomicU32::new(0);

        let result: Result<()> = with_backoff(REQUEST, "get box public", || async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(upstream(StatusCode::GATEWAY_TIMEOUT))
        })
        .await;

        assert_eq!(attempts.load(Ordering::SeqCst), REQUEST.max_attempts);
        assert_eq!(
            result.expect_err("stays an error").to_string(),
            "failed to get box public after 3 attempts: boom"
        );
    }
}
