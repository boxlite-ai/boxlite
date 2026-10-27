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
        if std::time::Instant::now() >= self.deadline {
            return Err(BoxliteError::Internal(format!(
                "{operation} did not finish within {} minutes",
                SNAPSHOT_WAIT_LIMIT.as_secs() / 60
            )));
        }
        tokio::time::sleep(self.delay).await;
        self.delay = (self.delay * 2).min(SNAPSHOT_POLL_MAX);
        Ok(())
    }
}
