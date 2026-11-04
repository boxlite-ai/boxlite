//! CLI-owned credentials; the runtime only receives a complete SSH configuration.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use boxlite::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use boxlite::{BoxliteRestOptions, BoxliteRuntime, LiteBox, SshAccount, SshConfig};
use sha2::{Digest, Sha256};

use crate::cli::GlobalFlags;

pub(super) async fn execute(target: &str, global: &GlobalFlags) -> Result<()> {
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
    println!("{}", configure(&sandbox, &home, &connection).await?);
    Ok(())
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

/// Apply managed credentials and describe how to connect after CLI exit.
async fn configure(
    sandbox: &LiteBox,
    home: &Path,
    connection: &ConnectionTarget,
) -> Result<String> {
    let home = fs::canonicalize(home).context("resolve runtime home")?;
    let directory = match connection.remote_scope()? {
        Some(scope) => home
            .join("ssh/remote")
            .join(scope)
            .join(sandbox.id().as_str()),
        None => {
            let layout = FilesystemLayout::new(home.clone(), FsLayoutConfig::without_bind_mount());
            layout
                .box_layout(sandbox.id().as_str(), false)?
                .root()
                .join("ssh")
        }
    };
    let private_key = directory.join("client_key");
    let command = connection_command(
        &std::env::current_exe()?,
        &home,
        sandbox.id().as_str(),
        &private_key,
        connection,
    )?;
    let config = tokio::task::spawn_blocking(move || managed_config(&directory)).await??;
    let status = sandbox.ssh().configure(config).await?;
    let guidance = if connection.rest.is_some() {
        "The connection requires enabled guest SSH and server tunnel support with inbound access. Proxy opens a public tunnel that remains open after exit.\n\nCopy and run the following command to enter the box:"
    } else {
        "Warning: CLI exit stops non-detached boxes. The connection command requires a running detached box (created with `boxlite create` or `boxlite run -d`).\n\nCopy and run the following command to enter a running detached box:"
    };
    Ok(format!(
        "SSH configured for box {}.\n\nPrivate key: {}\nLogin: box\nGuest address: {}\nSSH host key fingerprint: {}\n\n{guidance}\n\n  {command}\n",
        sandbox.name().unwrap_or(sandbox.id().as_str()),
        private_key.display(),
        status.listen_address,
        status.host_key_fingerprint,
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
    connection: &ConnectionTarget,
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
    let mut proxy = format!(
        "{} --home {}",
        quote(&text(executable)?),
        quote(&text(home)?),
    );
    if connection.context.chars().any(char::is_control) {
        bail!("SSH command context cannot contain control characters");
    }
    let hostname = if let Some(rest) = &connection.rest {
        let prefix = rest.path_prefix.as_deref().unwrap_or("");
        if rest.url.chars().chain(prefix.chars()).any(char::is_control) {
            bail!("SSH command routing cannot contain control characters");
        }
        // URL selection uses default credentials; the parser rejects combining it
        // with --context. Named contexts resolve their endpoint when proxy runs.
        if connection.context == crate::credentials::DEFAULT_PROFILE {
            proxy.push_str(&format!(" --url={}", quote(&rest.url)));
        } else {
            proxy.push_str(&format!(" --context={}", quote(&connection.context)));
        }
        if prefix.is_empty() {
            // Empty flags are invalid, but an empty environment value is ignored.
            proxy = format!("env BOXLITE_REST_PATH_PREFIX='' {proxy}");
        } else {
            proxy.push_str(&format!(" --path-prefix={}", quote(prefix)));
        }
        proxy.push_str(&format!(" ssh --proxy -- {}", quote(id)));
        format!(
            "boxlite-{}-{id}",
            connection.remote_scope()?.context("missing remote scope")?
        )
    } else {
        proxy.push_str(&format!(
            " --context {} ssh --proxy -- {}",
            quote(&connection.context),
            quote(id)
        ));
        id.to_string()
    };
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
        quote(&format!("box@{hostname}"))
    ))
}

#[cfg(test)]
#[path = "tests/setup.rs"]
mod tests;
