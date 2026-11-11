//! CLI-owned credentials; the runtime only receives a complete SSH configuration.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use boxlite::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use boxlite::{BoxliteRestOptions, BoxliteRuntime, LiteBox, SshAccount, SshConfig, SshStatus};
use sha2::{Digest, Sha256};

use crate::cli::GlobalFlags;

pub(super) async fn execute(target: &str, global: &GlobalFlags) -> Result<i32> {
    require_openssh()?;
    let connection = ConnectionTarget {
        context: global.resolved_context(),
        rest: global.rest_options()?,
    };
    let (runtime, home) = match &connection.rest {
        Some(options) => {
            let home = global
                .credential_store()
                .path()?
                .parent()
                .context("missing credential home")?
                .to_path_buf();
            (BoxliteRuntime::rest(options.clone())?, home)
        }
        None => {
            let options = global.resolve_runtime_options()?;
            let home = options.home_dir.clone();
            (global.create_runtime_with_options(options)?, home)
        }
    };
    let sandbox = runtime.get(target).await?.context("No such box")?;
    if connection.rest.is_some() {
        crate::credentials::create_secure_dir(&home)?;
    }
    let home = fs::canonicalize(home).context("resolve runtime home")?;
    let scope = connection.remote_scope()?;
    let directory = match &scope {
        Some(scope) => home
            .join("ssh/remote")
            .join(scope)
            .join(sandbox.id().as_str()),
        None => {
            let layout = FilesystemLayout::new(home, FsLayoutConfig::without_bind_mount());
            layout
                .box_layout(sandbox.id().as_str(), false)?
                .root()
                .join("ssh")
        }
    };
    let host_alias = match scope {
        Some(scope) => format!("boxlite-{scope}-{}", sandbox.id()),
        None => sandbox.id().to_string(),
    }
    .to_ascii_lowercase();
    let paths = super::connect::ConnectionPaths::new(&directory)?;
    let credentials = directory.clone();
    let (config, credentials_existed, expected_host_key) = tokio::task::spawn_blocking(move || {
        let credentials_existed = match fs::symlink_metadata(&credentials) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error).context("inspect SSH key directory"),
        };
        let config = managed_config(&credentials)?;
        let expected_host_key = public_key(&credentials.join("host_key"))?;
        Ok::<_, anyhow::Error>((config, credentials_existed, expected_host_key))
    })
    .await??;
    let status = prepare_ssh(&sandbox, config, credentials_existed, &expected_host_key).await?;
    super::connect::execute(&sandbox, &status, paths, &host_alias, &expected_host_key).await
}

struct ConnectionTarget {
    context: String,
    rest: Option<BoxliteRestOptions>,
}

impl ConnectionTarget {
    fn remote_scope(&self) -> Result<Option<String>> {
        self.rest
            .as_ref()
            .map(|rest| {
                // Fixed-size safe path component; credential rotation retains SSH identity.
                let identity = serde_json::to_vec(&(
                    &self.context,
                    rest.url.trim_end_matches('/'),
                    rest.path_prefix.as_deref().unwrap_or(""),
                ))?;
                Ok(format!("{:x}", Sha256::digest(identity)))
            })
            .transpose()
    }
}

fn require_openssh() -> Result<()> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for name in ["ssh", "ssh-keygen"] {
        let mut found = false;
        let mut permission_error = None;
        for directory in std::env::split_paths(&path) {
            match fs::metadata(directory.join(name)) {
                Ok(metadata) if metadata.is_file() && metadata.mode() & 0o111 != 0 => {
                    found = true;
                    break;
                }
                Ok(_) => {}
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        || error.raw_os_error() == Some(nix::libc::ENOTDIR) => {}
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    permission_error.get_or_insert(error);
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("inspect OpenSSH client tool '{name}'"));
                }
            }
        }
        if !found {
            if let Some(error) = permission_error {
                return Err(error).with_context(|| format!("inspect OpenSSH client tool '{name}'"));
            }
            bail!(
                "OpenSSH client tool '{name}' was not found in PATH; install the OpenSSH client package."
            );
        }
    }
    Ok(())
}

async fn prepare_ssh(
    sandbox: &LiteBox,
    config: SshConfig,
    credentials_existed: bool,
    expected_host_key: &str,
) -> Result<SshStatus> {
    let ssh = sandbox.ssh();
    let status = if !credentials_existed {
        ssh.configure(config).await?
    } else {
        let status = ssh.status().await?;
        if status.enabled {
            status
        } else if status.generation > 0 {
            ssh.enable().await?
        } else {
            // Generation zero also describes idle boxes with saved configuration.
            // Preserve configure's startup policy; never explicitly start the box.
            ssh.configure(config).await?
        }
    };
    fn identity(key: &str) -> (Option<&str>, Option<&str>) {
        let mut fields = key.split_whitespace();
        (fields.next(), fields.next())
    }
    if identity(&status.host_public_key) != identity(expected_host_key) {
        bail!(
            "SSH host key does not match the CLI-managed identity for box {}; refusing to reconfigure or connect",
            sandbox.id()
        );
    }
    if !status.enabled {
        bail!("guest SSH is disabled after preparing box {}", sandbox.id());
    }
    Ok(status)
}

fn managed_config(directory: &Path) -> Result<SshConfig> {
    match fs::symlink_metadata(directory) {
        Ok(_) => check_private(directory, true)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Install both keys together; failure leaves no half-created identity.
            let parent = directory.parent().context("missing box directory")?;
            fs::create_dir_all(parent).context("create box credential directory")?;
            let staging = tempfile::tempdir_in(parent)?;
            fs::set_permissions(staging.path(), fs::Permissions::from_mode(0o700))?;
            for name in ["client_key", "host_key"] {
                let output = Command::new("ssh-keygen")
                    .args(["-q", "-t", "ed25519", "-N", "", "-C", "boxlite", "-f"])
                    .arg(staging.path().join(name))
                    .stdin(Stdio::null())
                    .output()
                    .context("run ssh-keygen")?;
                if !output.status.success() {
                    bail!("ssh-keygen failed to generate {name}");
                }
            }
            fs::rename(staging.path(), directory).context("save SSH keys")?;
        }
        Err(error) => return Err(error).context("inspect SSH key directory"),
    }
    let client_public_key = public_key(&directory.join("client_key"))?;
    let host = directory.join("host_key");
    public_key(&host)?;
    Ok(SshConfig {
        listen_address: "0.0.0.0:22".into(),
        host_private_key: fs::read_to_string(host).context("read SSH host key")?,
        accounts: vec![SshAccount {
            login: "box".into(),
            authorized_keys: vec![client_public_key],
            ca: None,
        }],
    })
}

pub(super) fn check_private(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path).context("inspect SSH credentials")?;
    // SAFETY: geteuid has no arguments or memory-safety preconditions.
    let uid = unsafe { nix::libc::geteuid() };
    if metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        bail!(
            "SSH credentials must be owner-private {}: {}",
            if directory {
                "directories"
            } else {
                "regular files"
            },
            path.display()
        );
    }
    Ok(())
}

fn public_key(path: &Path) -> Result<String> {
    check_private(path, false)?;
    let output = Command::new("ssh-keygen")
        .args(["-y", "-P", "", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .context("read SSH key with ssh-keygen")?;
    if !output.status.success() {
        bail!("invalid or encrypted SSH key: {}", path.display());
    }
    Ok(String::from_utf8(output.stdout)
        .context("invalid SSH public key encoding")?
        .trim()
        .into())
}

#[cfg(test)]
#[path = "tests/setup.rs"]
mod tests;
