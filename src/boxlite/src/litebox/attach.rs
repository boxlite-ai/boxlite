//! What a client asks for when it attaches to a session.

/// Which session to follow, and whether the caller may write to it.
///
/// There is no `Default` impl: `stdin: true` is the docker-compatible polarity
/// but a surprising silent default, so the intent is spelled in the
/// constructor name instead.
#[derive(Debug, Clone)]
pub struct AttachOptions {
    execution_id: Option<String>,
    stdin: bool,
}

impl AttachOptions {
    /// The box's main command session — the container init.
    pub fn main() -> Self {
        Self {
            execution_id: None,
            stdin: true,
        }
    }

    /// Reattach to an already-running exec session by id.
    pub fn execution(execution_id: impl Into<String>) -> Self {
        Self {
            execution_id: Some(execution_id.into()),
            stdin: true,
        }
    }

    /// Attach read-only — docker's `--no-stdin`.
    ///
    /// The returned `Execution` has no stdin sender to call, and the REST
    /// backend asks the server to refuse writes on the wire, so this is a
    /// property of the attach rather than a promise the caller keeps.
    pub fn read_only(mut self) -> Self {
        self.stdin = false;
        self
    }

    pub(crate) fn execution_id(&self) -> Option<&str> {
        self.execution_id.as_deref()
    }

    pub(crate) fn wants_stdin(&self) -> bool {
        self.stdin
    }
}
