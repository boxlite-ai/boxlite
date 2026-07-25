//! Doubling backoff for the accept loop, so a run of TCP `accept()` errors
//! (e.g. an exhausted file-descriptor table) doesn't spin the guest hot.

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
        self.current = (self.current * 2).min(MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_up_to_max_and_resets() {
        let mut b = Backoff::new();
        assert_eq!(b.current, INITIAL);
        b.current = MAX / 2 + Duration::from_millis(1);
        let doubled = (b.current * 2).min(MAX);
        assert_eq!(doubled, MAX);
        b.reset();
        assert_eq!(b.current, INITIAL);
    }
}
