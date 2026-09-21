//! Retry an async lifecycle operation while the runtime reports a
//! *transient* state — e.g. the box is `Stopping` so a follow-up
//! `start` would otherwise hard-fail (POL-34).
//!
//! Scope is deliberately narrow: only `BoxliteError::InvalidState` with
//! a message containing a transient-state keyword (`stopping` /
//! `starting` / `in progress` / `transitioning`) triggers the retry
//! loop. Every other error — `NotFound`, `Unauthenticated`, generic
//! `Internal` — propagates immediately so a real failure isn't masked
//! by a multi-second wait.
//!
//! The total wait budget is bounded (default 10 s, override with
//! `BOXLITE_TRANSIENT_RETRY_MS` for tests) and uses exponential backoff
//! capped at 2 s so a long-running transition doesn't starve interactive
//! CLI feedback. 10 s comfortably covers a clean libkrun stop+restart
//! (1-2 s each) plus host load slack; pathological hangs (shim deadlock,
//! kernel stuck) won't unblock at 30 s either, so the longer default
//! traded user-visible wait for no extra signal.

use boxlite::{BoxliteError, BoxliteResult};
use std::future::Future;
use std::time::{Duration, Instant};

/// Default total time we'll spend waiting for a transient state to
/// clear before giving up.
const DEFAULT_BUDGET_MS: u64 = 10_000;
const INITIAL_BACKOFF_MS: u64 = 200;
const MAX_BACKOFF_MS: u64 = 2_000;

/// Returns true when the error message looks like a transient lifecycle
/// state — the box is mid-transition and the same call will likely
/// succeed once it settles.
///
/// We key on string content because the server emits these messages
/// via `BoxStatus::Display` and there is no dedicated `BoxliteError`
/// variant today. The match list is intentionally narrow: of the
/// `BoxStatus` variants in `src/boxlite/src/litebox/state.rs`, only
/// `Stopping` is genuinely transient — `Running` is "already there",
/// `Paused` is deliberate, `Failed` is permanent, `Configured` /
/// `Stopped` are valid `start` targets. The single producer today is
/// `box_impl.rs`'s `"Cannot start box in {} state"` (line 208), so the
/// keyword set follows what that message can actually contain.
/// Adding more keywords here without a corresponding producer would
/// be dead matching — keep this in sync with real error text.
fn is_transient_state(msg: &str) -> bool {
    msg.to_lowercase().contains("stopping")
}

fn budget() -> Duration {
    let ms = std::env::var("BOXLITE_TRANSIENT_RETRY_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_BUDGET_MS);
    Duration::from_millis(ms)
}

/// Run `op` and, if it returns `BoxliteError::InvalidState` with a
/// transient-state message, sleep + retry until either it succeeds, a
/// non-transient error surfaces, or the total wait budget elapses.
/// Other errors propagate on the first attempt.
pub async fn retry_on_transient_state<F, Fut, T>(op: F) -> BoxliteResult<T>
where
    F: Fn() -> Fut,
    Fut: Future<Output = BoxliteResult<T>>,
{
    let total = budget();
    let start = Instant::now();
    let mut backoff = Duration::from_millis(INITIAL_BACKOFF_MS);
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(BoxliteError::InvalidState(msg)) if is_transient_state(&msg) => {
                let elapsed = start.elapsed();
                if elapsed + backoff > total {
                    return Err(BoxliteError::InvalidState(format!(
                        "{msg} (gave up after {}s of transient-state retries)",
                        total.as_secs()
                    )));
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_millis(MAX_BACKOFF_MS));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Set `BOXLITE_TRANSIENT_RETRY_MS` for the duration of a test and
    /// restore it on drop. Tests run sequentially in the same process,
    /// so we hold a mutex across the whole test body.
    struct BudgetGuard {
        prev: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    impl BudgetGuard {
        fn new(ms: u64) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let prev = std::env::var_os("BOXLITE_TRANSIENT_RETRY_MS");
            // SAFETY: mutex above serializes any env-var mutation in this module.
            unsafe { std::env::set_var("BOXLITE_TRANSIENT_RETRY_MS", ms.to_string()) };
            Self { prev, _lock: lock }
        }
    }
    impl Drop for BudgetGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.prev {
                    Some(v) => std::env::set_var("BOXLITE_TRANSIENT_RETRY_MS", v),
                    None => std::env::remove_var("BOXLITE_TRANSIENT_RETRY_MS"),
                }
            }
        }
    }

    /// A transient-state error eventually resolves: the closure fails
    /// twice with "Cannot start box in stopping state" then succeeds,
    /// and the helper returns the success without surfacing the
    /// intermediate errors. Mirrors the POL-34 scenario where the user
    /// hit `start` while the box was still finishing its previous
    /// `stop`.
    #[tokio::test]
    async fn retries_through_transient_state_then_succeeds() {
        let _g = BudgetGuard::new(5_000);
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_in = attempts.clone();
        let result: BoxliteResult<&'static str> = retry_on_transient_state(|| {
            let attempts = attempts_in.clone();
            async move {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    Err(BoxliteError::InvalidState(
                        "Cannot start box in stopping state".into(),
                    ))
                } else {
                    Ok("started")
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), "started");
        assert!(
            attempts.load(Ordering::SeqCst) >= 3,
            "must have retried at least twice before succeeding"
        );
    }

    /// A persistent transient state hits the budget and gives up with
    /// an InvalidState that names the timeout — so a script gets a
    /// real failure signal instead of hanging.
    #[tokio::test]
    async fn gives_up_after_budget_elapses() {
        let _g = BudgetGuard::new(400);
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_in = attempts.clone();
        let result: BoxliteResult<()> = retry_on_transient_state(|| {
            let attempts = attempts_in.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(BoxliteError::InvalidState(
                    "Cannot stop box in stopping state".into(),
                ))
            }
        })
        .await;
        match result {
            Err(BoxliteError::InvalidState(msg)) => {
                assert!(msg.contains("gave up"), "expected 'gave up' summary: {msg}");
            }
            other => panic!("expected InvalidState giving up, got {other:?}"),
        }
        assert!(attempts.load(Ordering::SeqCst) >= 1);
    }

    /// Non-transient InvalidState (e.g. "Cannot start box in failed state")
    /// must propagate on the first attempt — the retry loop is for
    /// in-flight transitions, not "wrong terminal state".
    #[tokio::test]
    async fn non_transient_invalid_state_propagates_immediately() {
        let _g = BudgetGuard::new(60_000);
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_in = attempts.clone();
        let result: BoxliteResult<()> = retry_on_transient_state(|| {
            let attempts = attempts_in.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(BoxliteError::InvalidState(
                    "Cannot remove box with live pid 123".into(),
                ))
            }
        })
        .await;
        assert!(result.is_err(), "non-transient InvalidState must error");
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "must NOT retry a non-transient state error"
        );
    }

    /// Any non-InvalidState error (NotFound, Internal, …) is a different
    /// failure class — propagate immediately so retry logic can't mask
    /// real bugs.
    #[tokio::test]
    async fn other_error_kinds_propagate_immediately() {
        let _g = BudgetGuard::new(60_000);
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_in = attempts.clone();
        let result: BoxliteResult<()> = retry_on_transient_state(|| {
            let attempts = attempts_in.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(BoxliteError::NotFound("box ghost".into()))
            }
        })
        .await;
        assert!(matches!(result, Err(BoxliteError::NotFound(_))));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    /// Pins the narrow `stopping`-only classifier: messages whose
    /// keywords look transient but are not produced anywhere in
    /// the runtime today must propagate, not retry. Without this,
    /// the keyword list could silently grow back to "stopping /
    /// starting / in progress / transitioning" and the helper would
    /// happily burn the whole budget on dead-code matches.
    #[test]
    fn classifier_matches_only_stopping_today() {
        assert!(is_transient_state("Cannot start box in stopping state"));
        assert!(is_transient_state("STOPPING"));
        // None of these are produced by `box_impl.rs` or any other
        // `InvalidState` site in `src/boxlite`. They look plausible
        // but would be dead matches.
        assert!(!is_transient_state("Cannot start box in starting state"));
        assert!(!is_transient_state("transition in progress"));
        assert!(!is_transient_state("box is transitioning"));
        assert!(!is_transient_state("Cannot start box in running state"));
        assert!(!is_transient_state("Cannot start box in failed state"));
    }
}
