//! Host-path volumes for a self-hosted `boxlite serve`.
//!
//! A `host_path` names a directory on the machine running `serve`, not on the
//! caller's, so any client that can reach the API could otherwise bind `/` or
//! `~/.ssh` into a box. Nothing on this server records who owns a host
//! directory, and one shared API key cannot tell callers apart, so the operator
//! states which directories may be bound: `--host-path-root`, repeatable. With
//! none set, host paths are refused exactly as before.

use std::path::{Path, PathBuf};

use anyhow::Context;
use boxlite::BoxliteError;
use boxlite::runtime::options::VolumeSpec;

use super::types::VolumeSpecRequest;

/// The directories a create may bind from this machine.
#[derive(Debug, Default)]
pub(super) struct HostPathPolicy {
    /// Canonical roots, symlinks resolved once at startup.
    roots: Vec<PathBuf>,
}

impl HostPathPolicy {
    /// Resolve each `--host-path-root` up front, so a mistyped or missing root
    /// stops the server instead of making every later bind fail. A root inside
    /// another would make one bind able to contain another, so it stops the
    /// server too.
    pub(super) fn from_roots(roots: &[PathBuf]) -> anyhow::Result<Self> {
        let roots: Vec<PathBuf> = roots
            .iter()
            .map(|root| {
                let canonical = root
                    .canonicalize()
                    .with_context(|| format!("--host-path-root {}", root.display()))?;
                anyhow::ensure!(
                    canonical.is_dir(),
                    "--host-path-root {} is not a directory",
                    root.display()
                );
                Ok(canonical)
            })
            .collect::<anyhow::Result<_>>()?;
        for inner in &roots {
            if let Some(outer) = roots
                .iter()
                .find(|outer| inner != *outer && inner.starts_with(outer))
            {
                anyhow::bail!(
                    "--host-path-root {} is inside --host-path-root {}",
                    inner.display(),
                    outer.display()
                );
            }
        }
        Ok(Self { roots })
    }

    /// Whether any root is set, so a create may bind a host path at all.
    pub(super) fn enabled(&self) -> bool {
        !self.roots.is_empty()
    }

    /// Turn the request's `volumes` into bind mounts, refusing any entry this
    /// server cannot or may not bind.
    pub(super) fn resolve(
        &self,
        volumes: &[VolumeSpecRequest],
    ) -> Result<Vec<VolumeSpec>, BoxliteError> {
        volumes
            .iter()
            .map(|volume| self.resolve_one(volume))
            .collect()
    }

    fn resolve_one(&self, volume: &VolumeSpecRequest) -> Result<VolumeSpec, BoxliteError> {
        let host_path = match (&volume.managed_volume, &volume.host_path) {
            (Some(_), None) => {
                return Err(BoxliteError::InvalidArgument(
                    "managed volumes are not supported by boxlite serve".into(),
                ));
            }
            (None, Some(host_path)) => host_path,
            _ => {
                return Err(BoxliteError::InvalidArgument(
                    "a volume needs exactly one of managed_volume or host_path".into(),
                ));
            }
        };
        let mut spec = VolumeSpec::bind_mount(
            self.allowed_host_path(host_path)?.to_string_lossy(),
            volume.guest_path.clone(),
        );
        spec.read_only = volume.read_only;
        Ok(spec)
    }

    /// The canonical form of `host_path` when it is a direct child of a root.
    ///
    /// Canonicalizing first resolves `..` and every symlink, so
    /// `/srv/agents/a1/../../etc` or a planted link cannot point the bind
    /// elsewhere; comparing whole components keeps `/srv/agents-old` out. Only
    /// a direct child is bound, never the root or anything deeper: the runtime
    /// resolves the path again at every boot, so a box writing inside its own
    /// bind could otherwise turn a deeper bind of another box into a symlink to
    /// `/` before that box restarts. No box can write a root itself.
    fn allowed_host_path(&self, host_path: &str) -> Result<PathBuf, BoxliteError> {
        if self.roots.is_empty() {
            return Err(BoxliteError::InvalidArgument(
                "host_path volumes are disabled; start boxlite serve with --host-path-root <DIR> \
                 to allow binds of the entries directly inside DIR"
                    .into(),
            ));
        }
        if !Path::new(host_path).is_absolute() {
            return Err(BoxliteError::InvalidArgument(format!(
                "host_path {host_path:?} must be an absolute path"
            )));
        }
        // One refusal whether the path is missing, unreadable, or outside every
        // root: telling those apart would let a caller probe the filesystem
        // beyond the roots, which is what the roots exist to fence off.
        let refused = || {
            BoxliteError::InvalidArgument(format!(
                "host_path {host_path:?} is not an existing path directly inside any \
                 --host-path-root"
            ))
        };
        let canonical = Path::new(host_path).canonicalize().map_err(|_| refused())?;
        if !self
            .roots
            .iter()
            .any(|root| canonical.parent() == Some(root))
        {
            return Err(refused());
        }
        Ok(canonical)
    }
}
