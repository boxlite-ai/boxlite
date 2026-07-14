use super::stdio::InitOutputCompletion;
use super::zygote::{self, WaitResult};
use nix::unistd::Pid;
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InitTerminal {
    Exited { code: i32 },
    Signaled { signal: i32 },
    Failed { reason: String },
}

#[derive(Clone)]
pub(crate) struct InitSupervisor {
    generation: u64,
    terminal: watch::Sender<Option<InitTerminal>>,
}

impl InitSupervisor {
    pub(crate) fn new(generation: u64) -> Self {
        let (terminal, _) = watch::channel(None);
        Self {
            generation,
            terminal,
        }
    }

    pub(crate) fn matches_generation(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub(crate) fn fail(&self, reason: impl Into<String>) {
        self.terminal.send_replace(Some(InitTerminal::Failed {
            reason: reason.into(),
        }));
    }

    pub(crate) fn supervise(&self, pid: Pid, output_completion: InitOutputCompletion) {
        let terminal = self.terminal.clone();
        tokio::spawn(async move {
            let (process_result, output_result) =
                tokio::join!(wait_for_process(pid), output_completion.wait());

            let outcome = match (process_result, output_result) {
                (Ok(InitTerminal::Exited { code }), Ok(())) => InitTerminal::Exited { code },
                (Ok(InitTerminal::Signaled { signal }), Ok(())) => {
                    InitTerminal::Signaled { signal }
                }
                (Ok(InitTerminal::Failed { reason }), _) => InitTerminal::Failed { reason },
                (Err(reason), Ok(())) => InitTerminal::Failed { reason },
                (_, Err(reason)) => InitTerminal::Failed { reason },
            };
            terminal.send_replace(Some(outcome));
        });
    }

    /// Reconnects must observe an already-published terminal result immediately.
    pub(crate) async fn wait(&self) -> InitTerminal {
        let mut terminal = self.terminal.subscribe();
        loop {
            if let Some(outcome) = terminal.borrow().clone() {
                return outcome;
            }
            if terminal.changed().await.is_err() {
                return InitTerminal::Failed {
                    reason: "init supervisor stopped".to_string(),
                };
            }
        }
    }
}

async fn wait_for_process(pid: Pid) -> Result<InitTerminal, String> {
    loop {
        let result = tokio::task::spawn_blocking(move || {
            zygote::ZYGOTE.get().expect("zygote not started").wait(pid)
        })
        .await
        .map_err(|error| format!("init wait task failed: {error}"))?
        .map_err(|error| format!("zygote init wait failed: {error}"))?;

        match result {
            WaitResult::StillAlive => {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await
            }
            WaitResult::Exited { code } => return Ok(InitTerminal::Exited { code }),
            WaitResult::Signaled { signal } => return Ok(InitTerminal::Signaled { signal }),
            WaitResult::Failed { error } => return Ok(InitTerminal::Failed { reason: error }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wait_returns_an_already_published_terminal_value() {
        let supervisor = InitSupervisor::new(7);
        supervisor.fail("create failed");

        assert_eq!(
            supervisor.wait().await,
            InitTerminal::Failed {
                reason: "create failed".to_string()
            }
        );
    }

    #[test]
    fn generation_must_match_the_supervised_init() {
        let supervisor = InitSupervisor::new(7);

        assert!(supervisor.matches_generation(7));
        assert!(!supervisor.matches_generation(8));
    }
}
