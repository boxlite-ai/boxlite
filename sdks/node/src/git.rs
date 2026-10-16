//! Node.js bindings for git operations.

use std::sync::Arc;

use boxlite::{GitBranches, GitFileStatus, GitStatus, LiteBox};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// One changed path in a git status result.
#[napi(object)]
pub struct JsGitFileStatus {
    pub path: String,
    pub orig_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub untracked: bool,
}

/// Structured `git status` result.
#[napi(object)]
pub struct JsGitStatus {
    pub current_branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub branch_published: bool,
    pub head_commit: Option<String>,
    pub file_status: Vec<JsGitFileStatus>,
}

/// Local branches of a repository.
#[napi(object)]
pub struct JsGitBranches {
    pub current: Option<String>,
    pub names: Vec<String>,
}

impl From<GitStatus> for JsGitStatus {
    fn from(s: GitStatus) -> Self {
        let file = |f: GitFileStatus| JsGitFileStatus {
            staged: f.is_staged(),
            untracked: f.is_untracked(),
            path: f.path,
            orig_path: f.orig_path,
            index_status: f.index_status,
            worktree_status: f.worktree_status,
        };
        Self {
            current_branch: s.current_branch,
            upstream: s.upstream,
            ahead: s.ahead,
            behind: s.behind,
            branch_published: s.branch_published,
            head_commit: s.head_commit,
            file_status: s.file_status.into_iter().map(file).collect(),
        }
    }
}

/// Handle for git operations on a box.
///
/// Accessed as a property: `box.git.status(path)`.
#[napi]
pub struct JsGitHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[napi]
impl JsGitHandle {
    /// Structured status of the repository at `path`.
    #[napi]
    pub async fn status(&self, path: String) -> Result<JsGitStatus> {
        let st = self.handle.git().status(&path).await.map_err(map_err)?;
        Ok(st.into())
    }

    /// Local branches of the repository at `path`.
    #[napi]
    pub async fn branches(&self, path: String) -> Result<JsGitBranches> {
        let GitBranches { current, names } =
            self.handle.git().branches(&path).await.map_err(map_err)?;
        Ok(JsGitBranches { current, names })
    }
}
