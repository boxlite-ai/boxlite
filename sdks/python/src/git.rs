//! Python bindings for git operations.

use std::sync::Arc;

use boxlite::{GitBranches, GitFileStatus, GitStatus, LiteBox};
use pyo3::prelude::*;

use crate::util::map_err;

/// One changed path in a git status result.
#[pyclass(name = "GitFileStatus", frozen, get_all)]
#[derive(Clone)]
pub(crate) struct PyGitFileStatus {
    path: String,
    orig_path: Option<String>,
    index_status: String,
    worktree_status: String,
    staged: bool,
    untracked: bool,
}

/// Structured `git status` result.
#[pyclass(name = "GitStatus", frozen, get_all)]
pub(crate) struct PyGitStatus {
    current_branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    branch_published: bool,
    head_commit: Option<String>,
    file_status: Vec<PyGitFileStatus>,
}

/// Local branches of a repository.
#[pyclass(name = "GitBranches", frozen, get_all)]
pub(crate) struct PyGitBranches {
    current: Option<String>,
    names: Vec<String>,
}

impl From<GitStatus> for PyGitStatus {
    fn from(s: GitStatus) -> Self {
        let file = |f: GitFileStatus| PyGitFileStatus {
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
/// Accessed as a property: `box.git.configure_user(...)`.
#[pyclass(name = "GitHandle")]
pub(crate) struct PyGitHandle {
    pub(crate) handle: Arc<LiteBox>,
}

#[pymethods]
impl PyGitHandle {
    /// Set `user.name` and `user.email` for commits in this box.
    #[pyo3(signature = (name, email, scope=None, path=None))]
    fn configure_user<'py>(
        &self,
        py: Python<'py>,
        name: String,
        email: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .configure_user(&name, &email, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Write a git config value. `scope` is `"global"` (default), `"local"`,
    /// or `"system"`; `"local"` requires `path`.
    #[pyo3(signature = (key, value, scope=None, path=None))]
    fn set_config<'py>(
        &self,
        py: Python<'py>,
        key: String,
        value: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .set_config(&key, &value, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)?;
            Ok(())
        })
    }

    /// Read a git config value. Same `scope` / `path` rules as `set_config`.
    #[pyo3(signature = (key, scope=None, path=None))]
    fn get_config<'py>(
        &self,
        py: Python<'py>,
        key: String,
        scope: Option<String>,
        path: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle
                .git()
                .get_config(&key, scope.as_deref(), path.as_deref())
                .await
                .map_err(map_err)
        })
    }

    /// Structured status of the repository at `path`.
    fn status<'py>(&self, py: Python<'py>, path: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let st = handle.git().status(&path).await.map_err(map_err)?;
            Ok(PyGitStatus::from(st))
        })
    }

    /// Local branches of the repository at `path`.
    fn branches<'py>(&self, py: Python<'py>, path: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let GitBranches { current, names } =
                handle.git().branches(&path).await.map_err(map_err)?;
            Ok(PyGitBranches { current, names })
        })
    }

    fn __repr__(&self) -> String {
        format!("GitHandle(box_id={:?})", self.handle.id().to_string())
    }
}
