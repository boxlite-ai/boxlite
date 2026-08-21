use crate::service::exec::exec_handle::{ExecStderr, ExecStdout};
use async_stream::stream;
use boxlite_shared::{exec_output, ExecOutput, Stderr, Stdout};
use futures::{Stream, StreamExt};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tonic::Status;
use tracing::error;

const BUFFER_CAPACITY_BYTES: usize = 1024 * 1024;

pub(crate) type AttachStream = Pin<Box<dyn Stream<Item = Result<ExecOutput, Status>> + Send>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutputTerminalSummary {
    pub(crate) stdout: OutputStreamSummary,
    pub(crate) stderr: OutputStreamSummary,
    pub(crate) reader_failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutputStreamSummary {
    pub(crate) enabled: bool,
    pub(crate) total_bytes: u64,
}

#[derive(Clone)]
pub(crate) struct OutputManager {
    inner: Arc<Mutex<OutputState>>,
    updated: watch::Sender<()>,
    consumer_lease: Arc<AtomicBool>,
    drain_tasks: Arc<StdMutex<Vec<JoinHandle<()>>>>,
}

struct OutputState {
    entries: VecDeque<OutputEntry>,
    buffered_bytes: usize,
    oldest_sequence: u64,
    next_sequence: u64,
    failure: Option<ReaderFailure>,
    sealed: bool,
    stdout: StreamState,
    stderr: StreamState,
}

/// Why an attach was refused.
///
/// Deliberately small: the caller maps this to its own error and never forwards
/// a `tonic::Status` from here, so building one would size a 128-byte error only
/// to discard it a frame later.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AttachRefused {
    /// Another consumer already holds the lease.
    AlreadyAttached,
    /// Terminal output is being sealed, so no live attach can start.
    Finalizing,
}

struct ConsumerLease {
    claimed: Arc<AtomicBool>,
    updated: watch::Sender<()>,
}

impl Drop for ConsumerLease {
    fn drop(&mut self) {
        self.claimed.store(false, Ordering::Release);
        self.updated.send_replace(());
    }
}

struct ReaderFailure {
    sequence: u64,
    message: String,
}

struct OutputEntry {
    sequence: u64,
    output: ExecOutput,
    byte_len: usize,
}

#[derive(Clone, Copy, Debug)]
enum OutputSource {
    Stdout,
    Stderr,
}

struct StreamState {
    enabled: bool,
    finished: bool,
    total_bytes: u64,
    last_sequence: Option<u64>,
}

impl OutputManager {
    pub(crate) fn new(stdout: Option<ExecStdout>, stderr: Option<ExecStderr>) -> Self {
        let stdout_enabled = stdout.is_some();
        let stderr_enabled = stderr.is_some();
        let (updated, _) = watch::channel(());
        let manager = Self {
            inner: Arc::new(Mutex::new(OutputState {
                entries: VecDeque::new(),
                buffered_bytes: 0,
                oldest_sequence: 0,
                next_sequence: 0,
                failure: None,
                sealed: false,
                stdout: StreamState {
                    enabled: stdout_enabled,
                    finished: !stdout_enabled,
                    total_bytes: 0,
                    last_sequence: None,
                },
                stderr: StreamState {
                    enabled: stderr_enabled,
                    finished: !stderr_enabled,
                    total_bytes: 0,
                    last_sequence: None,
                },
            })),
            updated,
            consumer_lease: Arc::new(AtomicBool::new(false)),
            drain_tasks: Arc::new(StdMutex::new(Vec::new())),
        };

        if let Some(stdout) = stdout {
            manager.spawn(stdout, OutputSource::Stdout);
        }
        if let Some(stderr) = stderr {
            manager.spawn(stderr, OutputSource::Stderr);
        }

        manager
    }

    pub(crate) async fn shutdown_drains(&self) {
        let tasks = std::mem::take(
            &mut *self
                .drain_tasks
                .lock()
                .expect("output drain task lock poisoned"),
        );
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
    }

    pub(crate) async fn attach(&self) -> Result<AttachStream, AttachRefused> {
        let lease = self.claim_consumer().await?;
        if self.inner.lock().await.sealed {
            return Err(AttachRefused::Finalizing);
        }
        Ok(self.attach_stream(lease))
    }

    pub(crate) async fn attach_retained(&self) -> Result<AttachStream, AttachRefused> {
        let lease = self.claim_consumer().await?;
        Ok(self.attach_stream(lease))
    }

    /// The lease flag itself, so a holder can test it without taking any lock.
    pub(crate) fn consumer_lease_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.consumer_lease)
    }

    async fn claim_consumer(&self) -> Result<ConsumerLease, AttachRefused> {
        if self
            .consumer_lease
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(AttachRefused::AlreadyAttached);
        }

        let lease = ConsumerLease {
            claimed: Arc::clone(&self.consumer_lease),
            updated: self.updated.clone(),
        };
        Ok(lease)
    }

    fn attach_stream(&self, lease: ConsumerLease) -> AttachStream {
        let manager = self.clone();
        let output = stream! {
            let _lease = lease;
            let mut next_sequence = 0;
            let mut stdout_end_sent = false;
            let mut stderr_end_sent = false;
            let mut updates = manager.updated.subscribe();

            loop {
                enum Next {
                    Item(ExecOutput),
                    Error(Status),
                    Wait,
                    Done,
                }

                let next = {
                    let state = manager.inner.lock().await;

                    if next_sequence < state.oldest_sequence {
                        next_sequence = state.oldest_sequence;
                    }
                    let failure = state
                        .failure
                        .as_ref()
                        .filter(|failure| next_sequence >= failure.sequence);
                    if let Some(failure) = failure {
                        Next::Error(Status::internal(failure.message.clone()))
                    } else if state.stdout.ready_to_end(next_sequence) && !stdout_end_sent {
                        stdout_end_sent = true;
                        Next::Item(end_output(OutputSource::Stdout, state.stdout.total_bytes))
                    } else if state.stderr.ready_to_end(next_sequence) && !stderr_end_sent {
                        stderr_end_sent = true;
                        Next::Item(end_output(OutputSource::Stderr, state.stderr.total_bytes))
                    } else if next_sequence < state.next_sequence {
                        let index = (next_sequence - state.oldest_sequence) as usize;
                        let output = state
                            .entries
                            .get(index)
                            .expect("ring sequence must exist")
                            .output
                            .clone();
                        next_sequence += 1;
                        Next::Item(output)
                    } else if (!state.stdout.enabled || stdout_end_sent)
                        && (!state.stderr.enabled || stderr_end_sent)
                    {
                        Next::Done
                    } else {
                        Next::Wait
                    }
                };

                match next {
                    Next::Item(item) => yield Ok(item),
                    Next::Error(status) => {
                        yield Err(status);
                        break;
                    }
                    Next::Done => break,
                    Next::Wait => updates.changed().await.expect("output manager must outlive attach stream"),
                }
            }
        };

        Box::pin(output)
    }

    pub(crate) async fn seal(&self) -> bool {
        let mut state = self.inner.lock().await;
        if !state.stdout.finished || !state.stderr.finished {
            return false;
        }
        state.sealed = true;
        drop(state);
        self.updated.send_replace(());
        true
    }

    pub(crate) async fn terminal_summary(&self) -> Option<OutputTerminalSummary> {
        let state = self.inner.lock().await;
        if !state.stdout.finished || !state.stderr.finished {
            return None;
        }

        Some(OutputTerminalSummary {
            stdout: OutputStreamSummary {
                enabled: state.stdout.enabled,
                total_bytes: state.stdout.total_bytes,
            },
            stderr: OutputStreamSummary {
                enabled: state.stderr.enabled,
                total_bytes: state.stderr.total_bytes,
            },
            reader_failure: state
                .failure
                .as_ref()
                .map(|failure| failure.message.clone()),
        })
    }

    pub(crate) async fn sealed_terminal_summary(&self) -> Option<OutputTerminalSummary> {
        let state = self.inner.lock().await;
        if !state.sealed {
            return None;
        }
        Some(OutputTerminalSummary {
            stdout: OutputStreamSummary {
                enabled: state.stdout.enabled,
                total_bytes: state.stdout.total_bytes,
            },
            stderr: OutputStreamSummary {
                enabled: state.stderr.enabled,
                total_bytes: state.stderr.total_bytes,
            },
            reader_failure: state
                .failure
                .as_ref()
                .map(|failure| failure.message.clone()),
        })
    }

    pub(crate) async fn wait_terminal_summary(&self) -> OutputTerminalSummary {
        let mut updates = self.updated.subscribe();
        loop {
            if let Some(summary) = self.terminal_summary().await {
                return summary;
            }
            updates
                .changed()
                .await
                .expect("output manager must outlive its waiters");
        }
    }

    pub(crate) async fn retained_bytes(&self) -> usize {
        self.inner.lock().await.buffered_bytes
    }

    fn spawn<S>(&self, stream: S, source: OutputSource)
    where
        S: Stream<Item = std::io::Result<Vec<u8>>> + Send + Unpin + 'static,
    {
        let manager = self.clone();
        let task = tokio::spawn(async move {
            manager.drain(stream, source).await;
        });
        self.drain_tasks
            .lock()
            .expect("output drain task lock poisoned")
            .push(task);
    }

    async fn drain<S>(&self, mut stream: S, source: OutputSource)
    where
        S: Stream<Item = std::io::Result<Vec<u8>>> + Unpin,
    {
        while let Some(item) = stream.next().await {
            match item {
                Ok(data) => self.push(source, data).await,
                Err(error) => {
                    error!(?source, %error, "execution output reader failed");
                    self.reader_failed(source, error).await;
                    return;
                }
            }
        }
        self.reader_finished(source).await;
    }

    async fn push(&self, source: OutputSource, data: Vec<u8>) {
        let byte_len = data.len();

        let mut state = self.inner.lock().await;
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        let stream = state.stream_mut(source);
        stream.enabled = true;
        let offset = stream.total_bytes;
        stream.total_bytes += byte_len as u64;
        stream.last_sequence = Some(sequence);
        let output = data_output(source, data, offset);

        while state.buffered_bytes + byte_len > BUFFER_CAPACITY_BYTES {
            let Some(removed) = state.entries.pop_front() else {
                state.oldest_sequence = state.next_sequence;
                break;
            };
            state.buffered_bytes -= removed.byte_len;
            state.oldest_sequence = removed.sequence + 1;
        }

        if byte_len <= BUFFER_CAPACITY_BYTES {
            state.buffered_bytes += byte_len;
            state.entries.push_back(OutputEntry {
                sequence,
                output,
                byte_len,
            });
        }
        drop(state);
        self.updated.send_replace(());
    }

    async fn reader_finished(&self, source: OutputSource) {
        let mut state = self.inner.lock().await;
        state.stream_mut(source).finished = true;
        drop(state);
        self.updated.send_replace(());
    }

    async fn reader_failed(&self, source: OutputSource, error: std::io::Error) {
        let mut state = self.inner.lock().await;
        state.stream_mut(source).finished = true;
        if state.failure.is_none() {
            state.failure = Some(ReaderFailure {
                sequence: state.next_sequence,
                message: format!("failed to read {source:?}: {error}"),
            });
        }
        drop(state);
        self.updated.send_replace(());
    }
}

impl OutputState {
    fn stream_mut(&mut self, source: OutputSource) -> &mut StreamState {
        match source {
            OutputSource::Stdout => &mut self.stdout,
            OutputSource::Stderr => &mut self.stderr,
        }
    }
}

impl StreamState {
    fn ready_to_end(&self, next_sequence: u64) -> bool {
        self.enabled
            && self.finished
            && self
                .last_sequence
                .is_none_or(|last_sequence| next_sequence > last_sequence)
    }
}

fn data_output(source: OutputSource, data: Vec<u8>, offset: u64) -> ExecOutput {
    let event = match source {
        OutputSource::Stdout => exec_output::Event::Stdout(Stdout {
            data,
            offset: Some(offset),
            total_bytes: None,
        }),
        OutputSource::Stderr => exec_output::Event::Stderr(Stderr {
            data,
            offset: Some(offset),
            total_bytes: None,
        }),
    };
    ExecOutput { event: Some(event) }
}

fn end_output(source: OutputSource, total_bytes: u64) -> ExecOutput {
    let event = match source {
        OutputSource::Stdout => exec_output::Event::Stdout(Stdout {
            data: Vec::new(),
            offset: Some(total_bytes),
            total_bytes: Some(total_bytes),
        }),
        OutputSource::Stderr => exec_output::Event::Stderr(Stderr {
            data: Vec::new(),
            offset: Some(total_bytes),
            total_bytes: Some(total_bytes),
        }),
    };
    ExecOutput { event: Some(event) }
}

pub(crate) fn terminal_events(summary: &OutputTerminalSummary) -> Vec<ExecOutput> {
    let mut events = Vec::new();
    if summary.stdout.enabled {
        events.push(end_output(OutputSource::Stdout, summary.stdout.total_bytes));
    }
    if summary.stderr.enabled {
        events.push(end_output(OutputSource::Stderr, summary.stderr.total_bytes));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completed_stream_emits_total_bytes_after_replayed_data() {
        let manager = OutputManager::new(None, None);
        manager
            .push(OutputSource::Stdout, b"already sent".to_vec())
            .await;

        let mut output = manager.attach().await.unwrap();
        let first = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(first)) = first.event else {
            panic!("the replayed stdout data must be sent first");
        };
        assert_eq!(first.data, b"already sent");
        assert_eq!(first.offset, Some(0));
        assert_eq!(first.total_bytes, None);

        let end = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(end)) = end.event else {
            panic!("the stdout end frame must follow its replayed data");
        };
        assert!(end.data.is_empty());
        assert_eq!(end.offset, Some(b"already sent".len() as u64));
        assert_eq!(end.total_bytes, Some(b"already sent".len() as u64));
    }

    #[tokio::test]
    async fn waiting_for_a_terminal_summary_returns_after_both_streams_finish() {
        let manager = OutputManager::new(None, None);

        let summary = manager.wait_terminal_summary().await;
        assert_eq!(summary.stdout.total_bytes, 0);
        assert_eq!(summary.stderr.total_bytes, 0);
    }

    #[tokio::test]
    async fn retained_bytes_reports_the_shared_ring_size() {
        let manager = OutputManager::new(None, None);
        manager.push(OutputSource::Stdout, b"ring".to_vec()).await;

        assert_eq!(manager.retained_bytes().await, 4);
    }

    #[tokio::test]
    async fn closed_stdout_emits_its_end_before_stderr_closes() {
        let (stdout_read, stdout_write) = nix::unistd::pipe().unwrap();
        let (stderr_read, stderr_write) = nix::unistd::pipe().unwrap();
        let manager = OutputManager::new(
            Some(ExecStdout::new(stdout_read).unwrap()),
            Some(ExecStderr::new(stderr_read).unwrap()),
        );

        nix::unistd::write(&stdout_write, b"out").unwrap();
        drop(stdout_write);

        let mut output = manager.attach().await.unwrap();
        let first = tokio::time::timeout(std::time::Duration::from_secs(1), output.next())
            .await
            .expect("stdout data must arrive")
            .unwrap()
            .unwrap();
        let Some(exec_output::Event::Stdout(first)) = first.event else {
            panic!("the first event must be stdout data");
        };
        assert_eq!(first.data, b"out");

        let end = tokio::time::timeout(std::time::Duration::from_secs(1), output.next())
            .await
            .expect("stdout end must not wait for stderr EOF")
            .unwrap()
            .unwrap();
        let Some(exec_output::Event::Stdout(end)) = end.event else {
            panic!("stdout must emit its own end frame");
        };
        assert_eq!(end.total_bytes, Some(3));

        drop(stderr_write);
    }

    #[tokio::test]
    async fn end_frames_survive_when_all_data_is_evicted() {
        let manager = OutputManager::new(None, None);
        manager.push(OutputSource::Stdout, b"lost".to_vec()).await;
        manager
            .push(OutputSource::Stderr, vec![0; BUFFER_CAPACITY_BYTES + 1])
            .await;

        let mut output = manager.attach().await.unwrap();
        let stdout_end = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout_end)) = stdout_end.event else {
            panic!("stdout end frame must survive its evicted data");
        };
        assert!(stdout_end.data.is_empty());
        assert_eq!(stdout_end.total_bytes, Some(4));

        let stderr_end = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stderr(stderr_end)) = stderr_end.event else {
            panic!("stderr end frame must survive its evicted data");
        };
        assert!(stderr_end.data.is_empty());
        assert_eq!(
            stderr_end.total_bytes,
            Some((BUFFER_CAPACITY_BYTES + 1) as u64)
        );
    }

    #[tokio::test]
    async fn reader_failure_follows_buffered_output() {
        let manager = OutputManager::new(None, None);
        manager
            .push(OutputSource::Stdout, b"before failure".to_vec())
            .await;
        manager
            .reader_failed(
                OutputSource::Stdout,
                std::io::Error::other("simulated pipe failure"),
            )
            .await;

        let mut output = manager.attach().await.unwrap();
        let first = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(first)) = first.event else {
            panic!("buffered stdout must arrive before the reader failure");
        };
        assert_eq!(first.data, b"before failure");

        let error = output.next().await.unwrap().unwrap_err();
        assert_eq!(error.code(), tonic::Code::Internal);
        assert!(error.message().contains("simulated pipe failure"));
    }

    #[tokio::test]
    async fn first_reader_failure_stops_output_before_later_reader_failure() {
        let manager = OutputManager::new(None, None);
        manager
            .push(OutputSource::Stdout, b"before failure".to_vec())
            .await;
        manager
            .reader_failed(
                OutputSource::Stdout,
                std::io::Error::other("stdout failure"),
            )
            .await;
        manager
            .push(OutputSource::Stderr, b"after failure".to_vec())
            .await;
        manager
            .reader_failed(
                OutputSource::Stderr,
                std::io::Error::other("stderr failure"),
            )
            .await;

        let mut output = manager.attach().await.unwrap();
        let first = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(first)) = first.event else {
            panic!("buffered stdout must arrive before the first reader failure");
        };
        assert_eq!(first.data, b"before failure");

        let error = output.next().await.unwrap().unwrap_err();
        assert!(error.message().contains("stdout failure"));
    }

    #[tokio::test]
    async fn dropping_attach_stream_releases_consumer_lease() {
        let manager = OutputManager::new(None, None);

        let first = manager.attach().await.unwrap();
        let error = manager
            .attach()
            .await
            .err()
            .expect("the second Attach must be rejected");
        assert_eq!(error, AttachRefused::AlreadyAttached);

        drop(first);

        assert!(manager.attach().await.is_ok());
    }

    #[tokio::test]
    async fn terminal_summary_records_enabled_stream_totals() {
        let (stdout_read, stdout_write) = nix::unistd::pipe().unwrap();
        let manager = OutputManager::new(Some(ExecStdout::new(stdout_read).unwrap()), None);
        assert!(manager.terminal_summary().await.is_none());

        nix::unistd::write(&stdout_write, b"stdout").unwrap();
        drop(stdout_write);

        let summary = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(summary) = manager.terminal_summary().await {
                    break summary;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stdout EOF must produce a terminal summary");
        assert!(summary.stdout.enabled);
        assert_eq!(summary.stdout.total_bytes, 6);
        assert!(!summary.stderr.enabled);
        assert_eq!(summary.stderr.total_bytes, 0);
    }

    #[tokio::test]
    async fn seal_requires_terminal_output_and_rejects_new_attach() {
        let (stdout_read, stdout_write) = nix::unistd::pipe().unwrap();
        let manager = OutputManager::new(Some(ExecStdout::new(stdout_read).unwrap()), None);
        assert!(!manager.seal().await);

        drop(stdout_write);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if manager.terminal_summary().await.is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stdout EOF must make sealing possible");
        assert!(manager.seal().await);

        let error = manager
            .attach()
            .await
            .err()
            .expect("sealed output must reject Attach");
        assert_eq!(error, AttachRefused::Finalizing);
    }

    #[tokio::test]
    async fn sealing_keeps_an_existing_attach_stream_until_it_emits_terminal_output() {
        let (stdout_read, stdout_write) = nix::unistd::pipe().unwrap();
        let manager = OutputManager::new(Some(ExecStdout::new(stdout_read).unwrap()), None);
        let mut output = manager.attach().await.unwrap();

        nix::unistd::write(&stdout_write, b"buffered").unwrap();
        drop(stdout_write);
        manager.wait_terminal_summary().await;
        assert!(manager.seal().await);

        let data = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = data.event else {
            panic!("sealed stream must retain buffered stdout");
        };
        assert_eq!(stdout.data, b"buffered");

        let end = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Stdout(stdout)) = end.event else {
            panic!("sealed stream must emit stdout terminal event");
        };
        assert!(stdout.data.is_empty());
        assert_eq!(stdout.total_bytes, Some(8));
    }
}
