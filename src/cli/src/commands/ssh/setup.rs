//! CLI-owned credentials; the runtime only receives a complete SSH configuration.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use boxlite::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use boxlite::{LiteBox, SshAccount, SshConfig};

use crate::cli::GlobalFlags;

pub(super) async fn execute(target: &str, global: &GlobalFlags) -> Result<()> {
    super::require_local(global)?;
    let options = global.resolve_runtime_options()?;
    let home = options.home_dir.clone();
    let runtime = global.create_runtime_with_options(options)?;
    let sandbox = runtime.get(target).await?.context("No such box")?;
    println!(
        "{}",
        configure(&sandbox, &home, &global.resolved_context()).await?
    );
    Ok(())
}

/// Apply managed credentials and describe how to connect after CLI exit.
async fn configure(sandbox: &LiteBox, home: &Path, context: &str) -> Result<String> {
    let home = fs::canonicalize(home).context("resolve runtime home")?;
    let layout = FilesystemLayout::new(home.clone(), FsLayoutConfig::without_bind_mount());
    let directory = layout
        .box_layout(sandbox.id().as_str(), false)?
        .root()
        .join("ssh");
    let private_key = directory.join("client_key");
    let command = connection_command(
        &std::env::current_exe()?,
        &home,
        sandbox.id().as_str(),
        &private_key,
        context,
    )?;
    let config = tokio::task::spawn_blocking(move || managed_config(&directory)).await??;
    sandbox.ssh().configure(config).await?;
    Ok(format!(
        "SSH configured for box {}.\n\nPrivate key: {}\nLogin: box\nGuest address: 0.0.0.0:22\n\nWarning: CLI exit stops non-detached boxes. The connection command requires a running detached box (created with `boxlite create` or `boxlite run -d`).\n\nCopy and run the following command to enter a running detached box:\n\n  {command}\n",
        sandbox.name().unwrap_or(sandbox.id().as_str()),
        private_key.display(),
    ))
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
                    .context("run ssh-keygen; install the OpenSSH client tools")?;
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

fn check_private(path: &Path, directory: bool) -> Result<()> {
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

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn connection_command(
    executable: &Path,
    home: &Path,
    id: &str,
    key: &Path,
    context: &str,
) -> Result<String> {
    let text = |path: &Path| -> Result<String> {
        let value = path.to_str().context("SSH command paths must be UTF-8")?;
        if value.chars().any(char::is_control) || value.contains("${") {
            bail!(
                "SSH command paths cannot contain control characters or ${{: {}",
                path.display()
            );
        }
        Ok(value.into())
    };
    let proxy = format!(
        "{} --home {} --context {} ssh proxy {}",
        quote(&text(executable)?),
        quote(&text(home)?),
        quote(context),
        quote(id)
    );
    // Unlike -i's early filesystem check, IdentityFile expands SSH tokens
    // before loading the key. Quote for ssh_config first, then for the shell.
    let identity = text(key)?
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    Ok(format!(
        "ssh -o {} -o IdentitiesOnly=yes -o {} {}",
        quote(&format!("IdentityFile=\"{identity}\"")),
        quote(&format!("ProxyCommand={}", proxy.replace('%', "%%"))),
        quote(&format!("box@{id}"))
    ))
}

#[cfg(test)]
#[path = "tests/setup.rs"]
mod tests;
