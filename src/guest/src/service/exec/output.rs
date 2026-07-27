use crate::service::exec::exec_handle::{ExecStderr, ExecStdout};
use async_stream::stream;
use boxlite_shared::{exec_output, ExecOutput, OutputDropped, Stderr, Stdout};
use futures::{Stream, StreamExt};
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{watch, Mutex};
use tonic::Status;

const BUFFER_CAPACITY_BYTES: usize = 1024 * 1024;

pub(crate) type AttachStream = Pin<Box<dyn Stream<Item = Result<ExecOutput, Status>> + Send>>;

#[derive(Clone)]
pub(crate) struct OutputManager {
    inner: Arc<Mutex<OutputState>>,
    updated: watch::Sender<()>,
}

struct OutputState {
    entries: VecDeque<OutputEntry>,
    buffered_bytes: usize,
    oldest_sequence: u64,
    next_sequence: u64,
    pending_dropped: DroppedBytes,
    open_readers: usize,
    attached: bool,
    attachment_next_sequence: Option<u64>,
}

struct OutputEntry {
    sequence: u64,
    output: ExecOutput,
    source: OutputSource,
    byte_len: usize,
}

#[derive(Clone, Copy)]
enum OutputSource {
    Stdout,
    Stderr,
}

#[derive(Default)]
struct DroppedBytes {
    stdout: u64,
    stderr: u64,
}

impl DroppedBytes {
    fn record(&mut self, source: OutputSource, byte_len: usize) {
        let byte_len = byte_len as u64;
        match source {
            OutputSource::Stdout => self.stdout += byte_len,
            OutputSource::Stderr => self.stderr += byte_len,
        }
    }

    fn take(&mut self) -> Self {
        std::mem::take(self)
    }
}

impl OutputManager {
    pub(crate) fn new(stdout: Option<ExecStdout>, stderr: Option<ExecStderr>) -> Self {
        let open_readers = usize::from(stdout.is_some()) + usize::from(stderr.is_some());
        let (updated, _) = watch::channel(());
        let manager = Self {
            inner: Arc::new(Mutex::new(OutputState {
                entries: VecDeque::new(),
                buffered_bytes: 0,
                oldest_sequence: 0,
                next_sequence: 0,
                pending_dropped: DroppedBytes::default(),
                open_readers,
                attached: false,
                attachment_next_sequence: None,
            })),
            updated,
        };

        if let Some(stdout) = stdout {
            manager.spawn_stdout(stdout);
        }
        if let Some(stderr) = stderr {
            manager.spawn_stderr(stderr);
        }

        manager
    }

    pub(crate) async fn attach(&self) -> Result<AttachStream, Status> {
        {
            let mut state = self.inner.lock().await;
            if state.attached {
                return Err(Status::already_exists("Already attached"));
            }
            state.attached = true;
            state.attachment_next_sequence = Some(0);
        }

        let manager = self.clone();
        let output = stream! {
            let mut next_sequence = 0;
            let mut updates = manager.updated.subscribe();

            loop {
                enum Next {
                    Item(ExecOutput),
                    Wait,
                    Done,
                }

                let next = {
                    let mut state = manager.inner.lock().await;

                    if next_sequence < state.oldest_sequence {
                        next_sequence = state.oldest_sequence;
                        state.attachment_next_sequence = Some(next_sequence);
                        Next::Item(dropped_output(state.pending_dropped.take()))
                    } else if next_sequence < state.next_sequence {
                        let index = (next_sequence - state.oldest_sequence) as usize;
                        let output = state
                            .entries
                            .get(index)
                            .expect("ring sequence must exist")
                            .output
                            .clone();
                        next_sequence += 1;
                        state.attachment_next_sequence = Some(next_sequence);
                        Next::Item(output)
                    } else if state.open_readers == 0 {
                        Next::Done
                    } else {
                        Next::Wait
                    }
                };

                match next {
                    Next::Item(item) => yield Ok(item),
                    Next::Done => break,
                    Next::Wait => {
                        if updates.changed().await.is_err() {
                            break;
                        }
                    }
                }
            }
        };

        Ok(Box::pin(output))
    }

    fn spawn_stdout(&self, stdout: ExecStdout) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.drain(stdout, OutputSource::Stdout).await;
        });
    }

    fn spawn_stderr(&self, stderr: ExecStderr) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.drain(stderr, OutputSource::Stderr).await;
        });
    }

    async fn drain<S>(&self, mut stream: S, source: OutputSource)
    where
        S: Stream<Item = Vec<u8>> + Unpin,
    {
        while let Some(data) = stream.next().await {
            self.push(source, data).await;
        }
        self.reader_finished().await;
    }

    async fn push(&self, source: OutputSource, data: Vec<u8>) {
        let byte_len = data.len();
        let output = match source {
            OutputSource::Stdout => ExecOutput {
                event: Some(exec_output::Event::Stdout(Stdout { data })),
            },
            OutputSource::Stderr => ExecOutput {
                event: Some(exec_output::Event::Stderr(Stderr { data })),
            },
        };

        let mut state = self.inner.lock().await;
        let sequence = state.next_sequence;
        state.next_sequence += 1;

        while state.buffered_bytes + byte_len > BUFFER_CAPACITY_BYTES {
            let Some(removed) = state.entries.pop_front() else {
                if state.entry_is_unread(sequence) {
                    state.pending_dropped.record(source, byte_len);
                }
                state.oldest_sequence = state.next_sequence;
                break;
            };
            state.buffered_bytes -= removed.byte_len;
            if state.entry_is_unread(removed.sequence) {
                state
                    .pending_dropped
                    .record(removed.source, removed.byte_len);
            }
            state.oldest_sequence = removed.sequence + 1;
        }

        if byte_len <= BUFFER_CAPACITY_BYTES {
            state.buffered_bytes += byte_len;
            state.entries.push_back(OutputEntry {
                sequence,
                output,
                source,
                byte_len,
            });
        }
        drop(state);
        self.updated.send_replace(());
    }

    async fn reader_finished(&self) {
        let mut state = self.inner.lock().await;
        state.open_readers -= 1;
        drop(state);
        self.updated.send_replace(());
    }
}

impl OutputState {
    fn entry_is_unread(&self, sequence: u64) -> bool {
        self.attachment_next_sequence
            .is_none_or(|next_sequence| sequence >= next_sequence)
    }
}

fn dropped_output(dropped: DroppedBytes) -> ExecOutput {
    ExecOutput {
        event: Some(exec_output::Event::Dropped(OutputDropped {
            stdout_bytes: dropped.stdout,
            stderr_bytes: dropped.stderr,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropped_counts_only_entries_the_attachment_has_not_received() {
        let manager = OutputManager::new(None, None);
        manager
            .push(OutputSource::Stdout, b"already sent".to_vec())
            .await;

        let mut output = manager.attach().await.unwrap();
        assert!(matches!(
            output.next().await.unwrap().unwrap().event,
            Some(exec_output::Event::Stdout(_))
        ));

        for _ in 0..=BUFFER_CAPACITY_BYTES / 1024 {
            manager.push(OutputSource::Stderr, vec![0; 1024]).await;
        }

        let dropped = output.next().await.unwrap().unwrap();
        let Some(exec_output::Event::Dropped(dropped)) = dropped.event else {
            panic!("the unread stderr must be reported as dropped");
        };
        assert_eq!(dropped.stdout_bytes, 0);
        assert!(dropped.stderr_bytes > 0);
    }
}
