use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// How a snapshot or restore a server finishes after replying is followed:
/// polled with backoff, and given up on after a bound no real export reaches.
#[cfg(not(test))]
const SNAPSHOT_POLL_FIRST: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(test)]
const SNAPSHOT_POLL_FIRST: std::time::Duration = std::time::Duration::from_millis(10);
const SNAPSHOT_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(5);
const SNAPSHOT_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);

/// Paces the polling of one asynchronous snapshot operation.
pub(super) struct OperationPoll {
    delay: std::time::Duration,
    deadline: std::time::Instant,
}

impl OperationPoll {
    pub(super) fn new() -> Self {
        Self {
            delay: SNAPSHOT_POLL_FIRST,
            deadline: std::time::Instant::now() + SNAPSHOT_WAIT_LIMIT,
        }
    }

    pub(super) async fn wait(&mut self, operation: &str) -> BoxliteResult<()> {
        self.run(
            async {
                tokio::time::sleep(self.delay).await;
                Ok(())
            },
            operation,
        )
        .await?;
        self.delay = (self.delay * 2).min(SNAPSHOT_POLL_MAX);
        Ok(())
    }

    pub(super) async fn run<T>(
        &self,
        future: impl std::future::Future<Output = BoxliteResult<T>>,
        operation: &str,
    ) -> BoxliteResult<T> {
        let expired = || {
            BoxliteError::Internal(format!(
                "{operation} did not finish within {} minutes",
                SNAPSHOT_WAIT_LIMIT.as_secs() / 60
            ))
        };
        if std::time::Instant::now() >= self.deadline {
            return Err(expired());
        }
        tokio::time::timeout_at(tokio::time::Instant::from_std(self.deadline), future)
            .await
            .map_err(|_| expired())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn polling_request_is_cancelled_at_the_remaining_deadline() {
        let poll = OperationPoll {
            delay: std::time::Duration::ZERO,
            deadline: std::time::Instant::now() + std::time::Duration::from_millis(5),
        };
        let pending = std::future::pending::<BoxliteResult<()>>();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            poll.run(pending, "snapshot"),
        )
        .await;
        let error = result
            .expect("poll deadline must finish a pending request")
            .unwrap_err();
        assert!(error.to_string().contains("did not finish"));
    }

    #[tokio::test]
    async fn polling_delay_does_not_return_success_after_deadline() {
        let mut poll = OperationPoll {
            delay: std::time::Duration::from_millis(30),
            deadline: std::time::Instant::now() + std::time::Duration::from_millis(5),
        };
        let error = poll
            .wait("snapshot")
            .await
            .expect_err("deadline must bound sleep");
        assert!(error.to_string().contains("did not finish"));
    }
}
