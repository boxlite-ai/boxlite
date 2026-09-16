//! Shared lifetime for one SSH service start; cancellation never replaces draining.

use std::future::Future;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::{task_tracker::TaskTrackerToken, TaskTracker};

#[derive(Clone, Default)]
pub(super) struct TaskGroup {
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl TaskGroup {
    pub(super) fn spawn<F>(&self, future: F) -> JoinHandle<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.spawn_tracked(move |cancel| async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {},
                _ = future => {},
            }
        })
    }

    pub(super) fn spawn_tracked<F, Fut>(&self, task: F) -> JoinHandle<()>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.tracker.spawn(task(self.cancel.clone()))
    }

    pub(super) fn cancel(&self) {
        self.cancel.cancel();
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    // russh owns its internal task; the handler keeps it counted until Drop
    // has registered every cleanup task it produces.
    pub(super) fn token(&self) -> TaskTrackerToken {
        self.tracker.token()
    }

    pub(super) async fn wait(&self) {
        self.tracker.close();
        self.tracker.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn spawn_drops_running_future_on_shared_cancellation() {
        let tasks = TaskGroup::default();
        let (started_tx, started_rx) = oneshot::channel();
        let (held_tx, held_rx) = oneshot::channel::<()>();
        let task = tasks.spawn(async move {
            let _held = held_tx;
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started_rx.await.unwrap();
        tasks.clone().cancel();
        tasks.wait().await;
        task.await.unwrap();
        assert!(held_rx.await.is_err());
    }

    #[tokio::test]
    async fn cancellation_wins_over_ready_future() {
        let tasks = TaskGroup::default();
        tasks.cancel();
        let (ran_tx, ran_rx) = oneshot::channel();
        tasks
            .spawn(async move { ran_tx.send(()).unwrap() })
            .await
            .unwrap();
        assert!(ran_rx.await.is_err());
    }

    #[tokio::test]
    async fn wait_drains_cleanup_spawned_after_cancellation_and_close() {
        let tasks = TaskGroup::default();
        let producer = tasks.token();
        tasks.cancel();
        let wait = tasks.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());
        let (cleaning_tx, cleaning_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let task = tasks.spawn_tracked(move |cancel| async move {
            cancel.cancelled().await;
            cleaning_tx.send(()).unwrap();
            finish_rx.await.unwrap();
        });
        drop(producer);
        cleaning_rx.await.unwrap();
        assert!(futures::poll!(&mut wait).is_pending());
        finish_tx.send(()).unwrap();
        wait.await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_clone_does_not_cancel_group() {
        let tasks = TaskGroup::default();
        drop(tasks.clone());
        let task = tasks.spawn_tracked(|cancel| async move { assert!(!cancel.is_cancelled()) });
        tasks.wait().await;
        task.await.unwrap();
    }
}
