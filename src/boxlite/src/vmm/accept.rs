//! Retry transient listener failures without blocking cancellation or other ingress.

use std::future::Future;
use std::io;
use std::time::Duration;
use tokio::time::Instant;

const INITIAL: Duration = Duration::from_millis(5);
const MAX: Duration = Duration::from_secs(1);

pub(super) struct AcceptBackoff {
    delay: Duration,
    retry_at: Option<Instant>,
}

impl Default for AcceptBackoff {
    fn default() -> Self {
        Self {
            delay: INITIAL,
            retry_at: None,
        }
    }
}

impl AcceptBackoff {
    pub(super) async fn accept<T, F, Fut>(&mut self, mut accept: F) -> io::Result<T>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = io::Result<T>>,
    {
        loop {
            if let Some(deadline) = self.retry_at {
                tokio::time::sleep_until(deadline).await;
            }
            match accept().await {
                Ok(stream) => {
                    *self = Self::default();
                    return Ok(stream);
                }
                Err(error) if is_transient(&error) => {
                    tracing::warn!(%error, "listener accept failed; retrying");
                    // Store the deadline before yielding: select cancellation must
                    // not reset the delay and turn resource exhaustion into a spin.
                    self.retry_at = Some(Instant::now() + self.delay);
                    self.delay = (self.delay * 2).min(MAX);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn is_transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::OutOfMemory
    ) || matches!(
        error.raw_os_error(),
        Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test(start_paused = true)]
    async fn ssh_accept_recovers_caps_delay_and_resets_after_success() {
        let mut backoff = AcceptBackoff::default();
        let calls = Cell::new(0);
        let start = Instant::now();
        backoff
            .accept(|| {
                let call = calls.get();
                calls.set(call + 1);
                std::future::ready(if call < 12 {
                    Err(io::Error::from_raw_os_error(libc::EMFILE))
                } else {
                    Ok(())
                })
            })
            .await
            .unwrap();
        assert_eq!(calls.get(), 13);
        assert_eq!(start.elapsed(), Duration::from_millis(5275));
        let start = Instant::now();
        let calls = Cell::new(0);
        backoff
            .accept(|| {
                let call = calls.replace(calls.get() + 1);
                std::future::ready(if call == 0 {
                    Err(io::ErrorKind::ConnectionAborted.into())
                } else {
                    Ok(())
                })
            })
            .await
            .unwrap();
        assert_eq!(start.elapsed(), INITIAL);
        let error = backoff
            .accept(|| {
                std::future::ready::<io::Result<()>>(Err(io::ErrorKind::PermissionDenied.into()))
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[tokio::test(start_paused = true)]
    async fn ssh_accept_cancellation_preserves_retry_deadline() {
        let mut backoff = AcceptBackoff::default();
        let mut pending = Box::pin(backoff.accept(|| {
            std::future::ready::<io::Result<()>>(Err(io::Error::from_raw_os_error(libc::ENFILE)))
        }));
        assert!(futures::poll!(&mut pending).is_pending());
        drop(pending);
        let start = Instant::now();
        backoff.accept(|| std::future::ready(Ok(()))).await.unwrap();
        assert_eq!(start.elapsed(), INITIAL);
    }
}
