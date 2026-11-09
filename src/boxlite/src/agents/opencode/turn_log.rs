//! One turn's events, cut out of the agent's live event stream.
//!
//! ```text
//! live: … inbox.delivered(B) │ inbox.delivered(A) step.* text.* tool.* │ inbox.delivered(C) …
//!                     skipped ▲ start                         yielded │ ▲ boundary: ended?
//! ```
//!
//! OpenCode 2.2.2 cannot replay a turn's events: its session log carries only
//! public session events. So `send` opens the live stream before admitting a
//! turn and keeps it here for that turn. Where a turn ends is decided by the
//! same history read `wait` uses, asked at each boundary event and on every
//! idle tick: history can lag the stream, and a queued turn can end undelivered.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::{Stream, StreamExt};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::agents::{AgentEvent, AgentEventStream, AgentTurnStatus};
use crate::{BoxliteError, BoxliteResult};

/// Streams kept for the turns most recently sent; older ones are dropped,
/// which closes them, so turns nobody follows cannot pile up connections.
const MAX_OPENED: usize = 8;

/// Events buffered between the filter task and the reader.
const EVENT_BUFFER: usize = 64;

/// Live streams opened by `send`, one per recent turn.
#[derive(Clone, Default)]
pub(super) struct OpenedStreams(Arc<Mutex<VecDeque<(String, AgentEventStream)>>>);

impl std::fmt::Debug for OpenedStreams {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let turns = self.lock().len();
        formatter
            .debug_struct("OpenedStreams")
            .field("turns", &turns)
            .finish()
    }
}

impl OpenedStreams {
    pub(super) fn keep(&self, turn_id: &str, stream: AgentEventStream) {
        let mut opened = self.lock();
        opened.push_back((turn_id.to_owned(), stream));
        while opened.len() > MAX_OPENED {
            opened.pop_front();
        }
    }

    pub(super) fn take(&self, turn_id: &str) -> Option<AgentEventStream> {
        let mut opened = self.lock();
        let index = opened.iter().position(|(id, _)| id == turn_id)?;
        opened.remove(index).map(|(_, stream)| stream)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(String, AgentEventStream)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Whether a streamed turn has nothing more to show: it reached an outcome, or
/// it waits for input that nobody can give through this stream.
pub(super) fn has_ended(status: AgentTurnStatus) -> bool {
    !matches!(
        status,
        AgentTurnStatus::Queued | AgentTurnStatus::Running | AgentTurnStatus::Interrupting
    )
}

/// Filter the agent's live events to one turn. `ended` reads the turn's state
/// from history; it runs at each boundary event and after every idle `poll`.
pub(super) fn turn_events<S, F, Fut>(
    live: S,
    turn_id: String,
    poll: Duration,
    ended: F,
) -> AgentEventStream
where
    S: Stream<Item = BoxliteResult<AgentEvent>> + Send + Unpin + 'static,
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = BoxliteResult<bool>> + Send,
{
    let mut state = TurnWindow {
        live,
        turn_id,
        poll,
        ended,
        started: false,
        done: false,
    };
    // A task owns the filter, so the returned stream stays `Sync` although the
    // history reads are not; dropping the stream stops the task.
    let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                _ = sender.closed() => return,
                item = state.next() => item,
            };
            let Some(item) = item else { return };
            if sender.send(item).await.is_err() {
                return;
            }
        }
    });
    Box::pin(ReceiverStream::new(receiver))
}

struct TurnWindow<S, F> {
    live: S,
    turn_id: String,
    poll: Duration,
    ended: F,
    /// The turn's own `inbox.delivered` has been seen.
    started: bool,
    done: bool,
}

impl<S, F, Fut> TurnWindow<S, F>
where
    S: Stream<Item = BoxliteResult<AgentEvent>> + Unpin,
    F: Fn() -> Fut,
    Fut: Future<Output = BoxliteResult<bool>>,
{
    async fn next(&mut self) -> Option<BoxliteResult<AgentEvent>> {
        while !self.done {
            let event = match tokio::time::timeout(self.poll, self.live.next()).await {
                Err(_idle) => match (self.ended)().await {
                    Ok(false) => continue,
                    Ok(true) => return self.finish(None),
                    Err(error) => return self.finish(Some(error)),
                },
                Ok(None) => return self.finish(None),
                Ok(Some(Err(error))) => return self.finish(Some(error)),
                Ok(Some(Ok(event))) => event,
            };
            if !self.started {
                self.started = event.kind == "session.inbox.delivered"
                    && event.data["data"]["inboxID"].as_str() == Some(&*self.turn_id);
                if !self.started {
                    continue;
                }
            } else if is_boundary(&event.kind) {
                match (self.ended)().await {
                    Ok(false) => {}
                    Ok(true) => return self.finish(None),
                    Err(error) => return self.finish(Some(error)),
                }
            }
            return Some(Ok(AgentEvent {
                turn_id: Some(self.turn_id.clone()),
                ..event
            }));
        }
        None
    }

    fn finish(&mut self, error: Option<BoxliteError>) -> Option<BoxliteResult<AgentEvent>> {
        self.done = true;
        error.map(Err)
    }
}

/// Events after which another turn may own the session.
fn is_boundary(kind: &str) -> bool {
    kind == "session.inbox.delivered" || kind.starts_with("session.execution.")
}
