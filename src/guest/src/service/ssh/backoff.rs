//! Bounded retry delay for transient TCP accept failures.

use std::time::Duration;

const INITIAL: Duration = Duration::from_millis(10);
const MAX: Duration = Duration::from_secs(1);

pub(crate) struct Backoff {
    current: Duration,
}

impl Backoff {
    pub(crate) fn new() -> Self {
        Self { current: INITIAL }
    }

    pub(crate) fn reset(&mut self) {
        self.current = INITIAL;
    }

    pub(crate) async fn wait(&mut self) {
        tokio::time::sleep(self.current).await;
        self.advance();
    }

    fn advance(&mut self) {
        self.current = (self.current * 2).min(MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_is_capped_and_resettable() {
        let mut backoff = Backoff::new();
        assert_eq!(backoff.current, INITIAL);

        for _ in 0..16 {
            backoff.advance();
        }
        assert_eq!(backoff.current, MAX);

        backoff.reset();
        assert_eq!(backoff.current, INITIAL);
    }
}
