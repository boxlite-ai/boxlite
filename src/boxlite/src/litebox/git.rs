//! Git sub-resource on LiteBox: read-only `status()` and `branches()`.

use std::sync::Arc;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::litebox::BoxCommand;
use crate::runtime::backend::BoxBackend;

/// One changed path. `index_status` / `worktree_status` are git's
/// porcelain v2 XY codes (`.` unchanged, `M`, `A`, `D`, `R`, `C`, `T`, `U`,
/// `?` untracked).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    /// Source path of a rename or copy.
    pub orig_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

impl GitFileStatus {
    pub fn is_staged(&self) -> bool {
        !matches!(self.index_status.as_str(), "." | "?")
    }

    pub fn is_untracked(&self) -> bool {
        self.index_status == "?"
    }
}

/// Result of [`GitHandle::status`]. `current_branch` is `None` when HEAD is
/// detached, `head_commit` is `None` on an unborn branch, and
/// `branch_published` means the upstream exists.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStatus {
    pub current_branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub branch_published: bool,
    pub head_commit: Option<String>,
    pub file_status: Vec<GitFileStatus>,
}

/// Result of [`GitHandle::branches`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitBranches {
    pub current: Option<String>,
    pub names: Vec<String>,
}

/// Parse `git status --porcelain=v2 --branch -z` output. Guest output is
/// untrusted: malformed or unknown records return an error, never panic.
fn parse_status_v2(out: &str) -> BoxliteResult<GitStatus> {
    let bad = || BoxliteError::Internal("unexpected git status output".into());
    let mut st = GitStatus::default();
    let mut records = out.split('\0').filter(|r| !r.is_empty());
    while let Some(rec) = records.next() {
        let (kind, rest) = rec.split_once(' ').ok_or_else(bad)?;
        // Space-separated fields after the kind, the path last:
        // 1 = XY + 6 + path, 2 (rename) = XY + 7 + path, u (unmerged) = XY + 8 + path.
        let fields = match kind {
            "#" => {
                parse_status_header(&mut st, rest).ok_or_else(bad)?;
                continue;
            }
            "?" => {
                st.file_status
                    .push(file_entry("??", rest, None).ok_or_else(bad)?);
                continue;
            }
            "1" => 8,
            "2" => 9,
            "u" => 10,
            _ => return Err(bad()),
        };
        let parts: Vec<&str> = rest.splitn(fields, ' ').collect();
        if parts.len() != fields {
            return Err(bad());
        }
        let orig = match kind {
            "2" => Some(records.next().ok_or_else(bad)?.to_string()),
            _ => None,
        };
        st.file_status
            .push(file_entry(parts[0], parts[fields - 1], orig).ok_or_else(bad)?);
    }
    Ok(st)
}

fn file_entry(xy: &str, path: &str, orig_path: Option<String>) -> Option<GitFileStatus> {
    let (x, y) = (xy.get(..1)?, xy.get(1..)?);
    (xy.len() == 2 && xy.is_ascii() && !path.is_empty()).then(|| GitFileStatus {
        path: path.into(),
        orig_path,
        index_status: x.into(),
        worktree_status: y.into(),
    })
}

/// Apply one `# branch.*` header; unknown headers are ignored.
fn parse_status_header(st: &mut GitStatus, header: &str) -> Option<()> {
    let (key, val) = header.split_once(' ')?;
    match key {
        "branch.oid" => st.head_commit = (val != "(initial)").then(|| val.into()),
        "branch.head" => st.current_branch = (val != "(detached)").then(|| val.into()),
        "branch.upstream" => st.upstream = Some(val.into()),
        "branch.ab" => {
            let (a, b) = val.strip_prefix('+')?.split_once(" -")?;
            (st.ahead, st.behind) = (a.parse().ok()?, b.parse().ok()?);
            st.branch_published = true;
        }
        _ => {}
    }
    Some(())
}

/// Parse `git for-each-ref --format=%(HEAD)%00%(refname:short)` output.
fn parse_branches(out: &str) -> GitBranches {
    let mut b = GitBranches::default();
    for (marker, name) in out.lines().filter_map(|l| l.split_once('\0')) {
        if marker == "*" {
            b.current = Some(name.into());
        }
        b.names.push(name.into());
    }
    b
}

/// Handle for git operations on a LiteBox.
///
/// Obtained via `litebox.git()`. Owns a backend handle and can be
/// used independently from the originating `LiteBox` borrow.
#[derive(Clone)]
pub struct GitHandle {
    box_backend: Arc<dyn BoxBackend>,
}

impl std::fmt::Debug for GitHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHandle").finish_non_exhaustive()
    }
}

impl GitHandle {
    pub(crate) fn new(box_backend: Arc<dyn BoxBackend>) -> Self {
        Self { box_backend }
    }

    /// Status of the repository at `path`. NUL-delimited parsing keeps
    /// paths with spaces or newlines verbatim.
    pub async fn status(&self, path: &str) -> BoxliteResult<GitStatus> {
        let args = ["status", "--porcelain=v2", "--branch", "-z", "-uall"];
        parse_status_v2(&self.run_git_read(&args, path).await?)
    }

    /// Local branches of the repository at `path`, plus the current one.
    pub async fn branches(&self, path: &str) -> BoxliteResult<GitBranches> {
        let args = [
            "for-each-ref",
            "--format=%(HEAD)%00%(refname:short)",
            "refs/heads",
        ];
        let mut branches = parse_branches(&self.run_git_read(&args, path).await?);
        if branches.current.is_none() {
            // Unborn branch: no ref yet, but status still names it.
            let st = self.status(path).await?;
            branches.current = st.current_branch.filter(|_| st.head_commit.is_none());
        }
        Ok(branches)
    }

    async fn run_git_read(&self, args: &[&str], path: &str) -> BoxliteResult<String> {
        if path.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "path must not be empty".into(),
            ));
        }
        let cmd = BoxCommand::new("git").args(["-c", "core.quotepath=off", "-C", path]);
        let mut execution = self
            .box_backend
            .exec(cmd.args(args.iter().copied()))
            .await?;
        let mut stdout = String::new();
        if let Some(mut stream) = execution.stdout() {
            while let Some(chunk) = stream.next().await {
                stdout.push_str(&chunk);
            }
        }
        if !execution.wait().await?.success() {
            return Err(BoxliteError::Execution(format!("git {} failed", args[0])));
        }
        Ok(stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parses_headers_and_entries() {
        let st = parse_status_v2(
            "# branch.oid abc\0# branch.head main\0# branch.upstream o/main\0# branch.ab +1 -2\0",
        )
        .unwrap();
        assert_eq!(st.current_branch.as_deref(), Some("main"));
        assert_eq!(
            (st.upstream.as_deref(), st.ahead, st.behind),
            (Some("o/main"), 1, 2)
        );
        assert!(st.branch_published && st.file_status.is_empty());

        let h = "0".repeat(40);
        let out = format!(
            "# branch.oid (initial)\0# branch.head (detached)\0\
             1 .M N... 100644 100644 100644 {h} {h} README.md\0\
             1 A. N... 000000 100644 100644 {h} {h} with space.txt\0\
             2 R. N... 100644 100644 100644 {h} {h} R100 new name\0old name\0\
             u UU N... 100644 100644 100644 100644 {h} {h} {h} conflict\0\
             ? line\nbreak\0"
        );
        let st = parse_status_v2(&out).unwrap();
        assert_eq!((st.current_branch, st.head_commit), (None, None));
        assert!(!st.branch_published);
        let f = &st.file_status;
        let paths: Vec<_> = f.iter().map(|f| f.path.as_str()).collect();
        let want = [
            "README.md",
            "with space.txt",
            "new name",
            "conflict",
            "line\nbreak",
        ];
        assert_eq!(paths, want);
        assert!(f[0].worktree_status == "M" && !f[0].is_staged() && f[1].is_staged());
        assert_eq!(f[2].orig_path.as_deref(), Some("old name"));
        assert!(f[3].index_status == "U" && f[4].is_untracked());
    }

    #[test]
    fn status_rejects_malformed_records() {
        let h = "0".repeat(40);
        for rec in [
            "?".to_string(),
            "? ".into(),
            "1 .M N... 100644".into(),
            format!("1 é N... 100644 100644 100644 {h} {h} p"),
            format!("1 M N... 100644 100644 100644 {h} {h} p"),
            format!("2 R. N... 100644 100644 100644 {h} {h} R100 new"),
            "! ignored".into(),
            "x unknown".into(),
            "# branch.ab 1 2".into(),
        ] {
            assert!(parse_status_v2(&format!("{rec}\0")).is_err(), "{rec:?}");
        }
        assert!(parse_status_v2("# future.header x\0").is_ok());
    }

    #[test]
    fn branches_marks_current() {
        let b = parse_branches(" \0feature/x\n*\0main\n");
        assert_eq!(b.current.as_deref(), Some("main"));
        assert_eq!(b.names, ["feature/x", "main"]);
    }
}
