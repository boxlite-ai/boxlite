//! Git sub-resource on LiteBox.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use futures::StreamExt;

use crate::litebox::BoxCommand;
use crate::runtime::backend::BoxBackend;

/// Closed set of `git config` scopes. Public methods take `&str`; flags
/// written into the guest argv come from this enum, never from interpolation.
#[derive(Clone, Copy, Debug)]
enum GitConfigScope {
    Global,
    Local,
    System,
}

impl GitConfigScope {
    fn parse(scope: &str) -> BoxliteResult<Self> {
        match scope {
            "global" => Ok(Self::Global),
            "local" => Ok(Self::Local),
            "system" => Ok(Self::System),
            other => Err(BoxliteError::InvalidArgument(format!(
                "scope must be \"global\", \"local\", or \"system\", got {other:?}"
            ))),
        }
    }

    fn as_flag(self) -> &'static str {
        match self {
            Self::Global => "--global",
            Self::Local => "--local",
            Self::System => "--system",
        }
    }
}

/// Map a failed git invocation. Identity errors name `configure_user()`
/// instead of passing git's "Please tell me who you are" through verbatim.
///
/// `git config` never emits that message; `commit()` will call this.
#[allow(dead_code)]
fn map_git_failure(stderr: &str, fallback: impl Into<String>) -> BoxliteError {
    if stderr.contains("Please tell me who you are") {
        BoxliteError::InvalidArgument(
            "git identity is not configured; call configure_user() first".into(),
        )
    } else {
        BoxliteError::Execution(fallback.into())
    }
}

/// Handle for git operations on a LiteBox.
///
/// Obtained via `litebox.git()`. Owns a backend handle and can be
/// used independently from the originating `LiteBox` borrow.
#[derive(Clone)]
pub struct GitHandle {
    box_backend: Arc<dyn BoxBackend>,
}

impl GitHandle {
    pub(crate) fn new(box_backend: Arc<dyn BoxBackend>) -> Self {
        Self { box_backend }
    }

    /// Write a git config value. `scope` is `"global"` (default), `"local"`,
    /// or `"system"`; `"local"` requires `path`.
    pub async fn set_config(
        &self,
        key: &str,
        value: &str,
        scope: Option<&str>,
        path: Option<&str>,
    ) -> BoxliteResult<()> {
        let scope = scope.unwrap_or("global");
        self.run_git(&[key, value], scope, path).await?;
        Ok(())
    }

    /// Read a git config value. Same `scope` / `path` rules as [`Self::set_config`].
    pub async fn get_config(
        &self,
        key: &str,
        scope: Option<&str>,
        path: Option<&str>,
    ) -> BoxliteResult<String> {
        let scope = scope.unwrap_or("global");
        let out = self.run_git(&["--get", key], scope, path).await?;
        Ok(out.trim().to_string())
    }

    /// Set `user.name` and `user.email` for commits in this box.
    pub async fn configure_user(
        &self,
        name: &str,
        email: &str,
        scope: Option<&str>,
        path: Option<&str>,
    ) -> BoxliteResult<()> {
        self.set_config("user.name", name, scope, path).await?;
        self.set_config("user.email", email, scope, path).await?;
        Ok(())
    }

    async fn run_git(
        &self,
        args: &[&str],
        scope: &str,
        path: Option<&str>,
    ) -> BoxliteResult<String> {
        let scope = GitConfigScope::parse(scope)?;
        if matches!(scope, GitConfigScope::Local) && path.is_none() {
            return Err(BoxliteError::InvalidArgument(
                "scope=\"local\" requires path".into(),
            ));
        }

        let mut cmd = BoxCommand::new("git").arg("config").arg(scope.as_flag());
        for arg in args {
            cmd = cmd.arg(*arg);
        }
        if let Some(dir) = path {
            cmd = cmd.working_dir(dir);
        }

        let mut execution = self.box_backend.exec(cmd).await?;

        let mut stdout = String::new();
        if let Some(mut stream) = execution.stdout() {
            while let Some(chunk) = stream.next().await {
                stdout.push_str(&chunk);
            }
        }

        let result = execution.wait().await?;
        if !result.success() {
            // Typed error; do not pass git stderr through.
            return Err(BoxliteError::Execution("git config failed".into()));
        }
        Ok(stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_known_scopes() {
        assert_eq!(
            GitConfigScope::parse("global").unwrap().as_flag(),
            "--global"
        );
        assert_eq!(GitConfigScope::parse("local").unwrap().as_flag(), "--local");
        assert_eq!(
            GitConfigScope::parse("system").unwrap().as_flag(),
            "--system"
        );
    }

    #[test]
    fn parse_rejects_unknown_scope() {
        for scope in ["file", "globel", "--global", ""] {
            let err = GitConfigScope::parse(scope).unwrap_err();
            assert!(
                matches!(err, BoxliteError::InvalidArgument(ref msg) if msg.contains("global")),
                "{scope:?} -> {err}"
            );
        }
    }
}
