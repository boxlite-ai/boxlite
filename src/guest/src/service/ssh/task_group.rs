//! Shared lifetime for one SSH service start; cancellation never replaces draining.

use std::future::Future;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::{task_tracker::TaskTrackerToken, TaskTracker};

#[derive(Default)]
pub(super) struct TaskGroup {
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl TaskGroup {
    pub(super) fn child(&self) -> Arc<Self> {
        let child = Arc::new(Self {
            cancel: self.cancel.child_token(),
            tracker: TaskTracker::new(),
        });
        let tracker = child.tracker.clone();
        // Keep draining through cancellation without retaining the child's owner.
        self.tracker.spawn(async move { tracker.wait().await });
        child
    }

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

    pub(super) async fn cancelled(&self) {
        self.cancel.cancelled().await;
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

impl Drop for TaskGroup {
    fn drop(&mut self) {
        self.tracker.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    async fn completes<F: Future>(future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("task group did not finish")
    }

    #[tokio::test]
    async fn last_arc_closes_without_cancelling() {
        let tasks = Arc::new(TaskGroup::default());
        let tracker = tasks.tracker.clone();
        let cancel = tasks.cancel.clone();
        drop(tasks);
        assert!(tracker.is_closed(), "last Arc must close the tracker");
        assert!(!cancel.is_cancelled());
    }

    #[tokio::test]
    async fn spawn_drops_running_future_on_shared_cancellation() {
        let tasks = Arc::new(TaskGroup::default());
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
        let tasks = Arc::new(TaskGroup::default());
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
        let tasks = Arc::new(TaskGroup::default());
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
        let tasks = Arc::new(TaskGroup::default());
        drop(tasks.clone());
        assert!(!tasks.tracker.is_closed());
        let task = tasks.spawn_tracked(|cancel| async move { assert!(!cancel.is_cancelled()) });
        tasks.wait().await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_propagates_only_to_descendants() {
        let parent = Arc::new(TaskGroup::default());
        let child = parent.child();
        let grandchild = child.child();
        let sibling = parent.child();
        child.cancel();
        assert!(child.is_cancelled());
        assert!(grandchild.is_cancelled());
        assert!(!parent.is_cancelled());
        assert!(!sibling.is_cancelled());
        let sibling_child = sibling.child();
        parent.cancel();
        assert!(sibling.is_cancelled());
        assert!(sibling_child.is_cancelled());
        drop((child, grandchild, sibling, sibling_child));
        completes(parent.wait()).await;
    }

    #[tokio::test]
    async fn parent_waits_for_last_arc_of_empty_child() {
        let parent = Arc::new(TaskGroup::default());
        let child = parent.child();
        let last_child = child.clone();
        let wait = parent.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());
        drop(child);
        assert!(!last_child.tracker.is_closed());
        assert!(futures::poll!(&mut wait).is_pending());
        drop(last_child);
        completes(wait).await;
    }

    #[tokio::test]
    async fn nested_groups_drain_without_closing_siblings() {
        let parent = Arc::new(TaskGroup::default());
        let child = parent.child();
        let grandchild = child.child();
        let sibling = parent.child();
        let (finish_tx, finish_rx) = oneshot::channel();
        grandchild.spawn_tracked(|_| async move { finish_rx.await.unwrap() });
        drop(grandchild);
        let child_wait = child.wait();
        let parent_wait = parent.wait();
        tokio::pin!(child_wait, parent_wait);
        assert!(futures::poll!(&mut child_wait).is_pending());
        assert!(futures::poll!(&mut parent_wait).is_pending());
        finish_tx.send(()).unwrap();
        completes(child_wait).await;
        assert!(!sibling.tracker.is_closed());
        assert!(!sibling.is_cancelled());
        assert!(futures::poll!(&mut parent_wait).is_pending());
        completes(sibling.wait()).await;
        completes(parent_wait).await;
    }

    #[tokio::test]
    async fn cancelled_parent_still_waits_for_child_cleanup() {
        let parent = Arc::new(TaskGroup::default());
        let child = parent.child();
        parent.cancel();
        let wait = parent.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        child.spawn_tracked(|cancel| async move {
            assert!(cancel.is_cancelled());
            started_tx.send(()).unwrap();
            finish_rx.await.unwrap();
        });
        drop(child);
        completes(started_rx).await.unwrap();
        assert!(futures::poll!(&mut wait).is_pending());
        finish_tx.send(()).unwrap();
        completes(wait).await;
    }

    struct CleanupOnDrop {
        tasks: Arc<TaskGroup>,
        finish: Option<oneshot::Receiver<()>>,
    }

    impl Drop for CleanupOnDrop {
        fn drop(&mut self) {
            let finish = self.finish.take().unwrap();
            self.tasks.spawn_tracked(|_| async move {
                finish.await.unwrap();
            });
        }
    }

    #[tokio::test]
    async fn abort_before_first_poll_keeps_destructor_cleanup_tracked() {
        let parent = Arc::new(TaskGroup::default());
        let child = parent.child();
        let (finish_tx, finish_rx) = oneshot::channel();
        let cleanup = CleanupOnDrop {
            tasks: child.clone(),
            finish: Some(finish_rx),
        };
        let (polled_tx, polled_rx) = oneshot::channel();
        let task = child.spawn_tracked(|_| async move {
            let _cleanup = cleanup;
            polled_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        // The current-thread runtime cannot poll the task before this abort.
        task.abort();
        parent.cancel();
        drop(child);
        let wait = parent.wait();
        tokio::pin!(wait);
        assert!(futures::poll!(&mut wait).is_pending());
        assert!(completes(task).await.unwrap_err().is_cancelled());
        assert!(polled_rx.await.is_err());
        assert!(futures::poll!(&mut wait).is_pending());
        finish_tx.send(()).unwrap();
        completes(wait).await;
    }

    #[tokio::test]
    async fn finished_children_leave_no_parent_waiters() {
        let parent = Arc::new(TaskGroup::default());
        for _ in 0..32 {
            let child = parent.child();
            assert_eq!(parent.tracker.len(), 1);
            drop(child);
            completes(parent.wait()).await;
            assert!(parent.tracker.is_empty());
            parent.tracker.reopen();
        }
    }
}
