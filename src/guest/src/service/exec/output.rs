use crate::service::exec::exec_handle::{ExecStderr, ExecStdout};
use async_stream::stream;
use boxlite_shared::{exec_output, ExecOutput, Stderr, Stdout};
use futures::{Stream, StreamExt};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tonic::Status;
use tracing::error;

const BUFFER_CAPACITY_BYTES: usize = 1024 * 1024;

pub(crate) type AttachStream = Pin<Box<dyn Stream<Item = Result<ExecOutput, Status>> + Send>>;

#[derive(Clone)]
pub(crate) struct OutputManager {
    inner: Arc<Mutex<OutputState>>,
    updated: watch::Sender<()>,
    drain_tasks: Arc<StdMutex<Vec<JoinHandle<()>>>>,
}

struct OutputState {
    entries: VecDeque<OutputEntry>,
    buffered_bytes: usize,
    oldest_sequence: u64,
    next_sequence: u64,
    failure: Option<ReaderFailure>,
    attached: bool,
    stdout: StreamState,
    stderr: StreamState,
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
                attached: false,
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

    pub(crate) async fn attach(&self) -> Result<AttachStream, Status> {
        {
            let mut state = self.inner.lock().await;
            if state.attached {
                return Err(Status::already_exists("Already attached"));
            }
            state.attached = true;
        }

        let manager = self.clone();
        let output = stream! {
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

        Ok(Box::pin(output))
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
}
