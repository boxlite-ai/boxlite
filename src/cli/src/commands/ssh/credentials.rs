//! A locked local journal owns key material across ambiguous configure outcomes.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, ensure};
use boxlite::{LiteBox, SshAccount, SshConfig, SshStatus};
use nix::fcntl::{Flock, FlockArg};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::connection::{Login, Target};
use crate::cli::GlobalFlags;

const LISTEN: &str = "0.0.0.0:22";

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    material: String,
    generation: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Journal {
    active: Option<Record>,
    pending: Option<Record>,
}

pub(super) struct Credentials {
    root: PathBuf,
    _lock: Flock<File>,
    journal: Journal,
}

impl Credentials {
    pub(super) async fn prepare(
        global: &GlobalFlags,
        sandbox: &LiteBox,
        replace: bool,
    ) -> Result<Login> {
        let target = Target::resolve(global)?;
        let id = sandbox.id();
        let mut credentials = Self::open(global, &target.identity, id)?;
        let ssh = sandbox.ssh();
        let current = ssh.status().await?;

        if current.enabled && !replace {
            // A lost configure reply is confirmed only for the expected next
            // generation and our host key. Never blindly retry the mutation.
            for record in [
                credentials.journal.pending.clone(),
                credentials.journal.active.clone(),
            ]
            .into_iter()
            .flatten()
            {
                if credentials.matches(&record, &current)? {
                    credentials.journal.active = Some(record.clone());
                    credentials.journal.pending = None;
                    credentials.save()?;
                    return credentials.login(target, id.as_str(), &record, &current);
                }
            }
            anyhow::bail!(
                "SSH is enabled with a configuration not owned by this CLI record; use --replace to generate new keys and disconnect existing sessions"
            );
        }

        let material = if replace {
            credentials.generate().await?
        } else if let Some(record) = credentials
            .journal
            .pending
            .as_ref()
            .or(credentials.journal.active.as_ref())
        {
            record.material.clone()
        } else {
            credentials.generate().await?
        };
        let record = Record {
            material,
            generation: current
                .generation
                .checked_add(1)
                .context("SSH generation exhausted")?,
        };
        let config = credentials.config(&record)?;
        credentials.journal.pending = Some(record.clone());
        credentials.save()?;
        let status = ssh.configure(config).await.context("Configure guest SSH; local keys retained for status confirmation on the next invocation")?;
        ensure!(
            credentials.matches(&record, &status)?,
            "SSH configure returned an unexpected identity or generation; local keys retained"
        );
        credentials.journal.active = Some(record.clone());
        credentials.journal.pending = None;
        credentials.save()?;
        credentials.login(target, id.as_str(), &record, &status)
    }

    fn open(global: &GlobalFlags, target: &str, id: &boxlite::runtime::id::BoxID) -> Result<Self> {
        let credential_file = global.credential_store().path()?;
        let home = credential_file
            .parent()
            .context("Credential home missing")?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(home)
            .context("Create local credential home")?;
        let home = fs::canonicalize(home).context("Resolve credential home")?;
        let digest = format!("{:x}", Sha256::digest(target.as_bytes()));
        let ssh = home.join("ssh");
        secure_directory(&ssh)?;
        let target_dir = ssh.join(digest);
        secure_directory(&target_dir)?;
        let root = target_dir.join(id.as_str());
        secure_directory(&root)?;
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(root.join("lock"))
            .context("Open SSH preparation lock")?;
        let lock =
            Flock::lock(lock_file, FlockArg::LockExclusiveNonblock).map_err(|(_, error)| {
                anyhow!("SSH preparation already in progress or lock unavailable: {error}")
            })?;
        let journal = match fs::read(root.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("Read SSH credential record")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(error) => return Err(error).context("Read SSH credential record"),
        };
        Ok(Self {
            root,
            _lock: lock,
            journal,
        })
    }

    fn material_dir(&self, record: &Record) -> Result<PathBuf> {
        ensure!(
            ulid::Ulid::from_string(&record.material).is_ok(),
            "Invalid SSH material record"
        );
        Ok(self.root.join(&record.material))
    }

    fn matches(&self, record: &Record, status: &SshStatus) -> Result<bool> {
        if !status.enabled
            || status.generation != record.generation
            || status.listen_address != LISTEN
        {
            return Ok(false);
        }
        let public = fs::read_to_string(self.material_dir(record)?.join("host.pub"))
            .context("Read saved SSH host public key")?;
        Ok(public_key(&public) == public_key(&status.host_public_key))
    }

    fn config(&self, record: &Record) -> Result<SshConfig> {
        let dir = self.material_dir(record)?;
        Ok(SshConfig {
            listen_address: LISTEN.into(),
            host_private_key: fs::read_to_string(dir.join("host"))
                .context("Read saved SSH host private key")?,
            accounts: vec![SshAccount {
                login: "boxlite".into(),
                authorized_keys: vec![
                    fs::read_to_string(dir.join("identity.pub"))
                        .context("Read saved SSH user public key")?,
                ],
                ca: None,
            }],
        })
    }

    async fn generate(&self) -> Result<String> {
        let material = ulid::Ulid::new().to_string();
        let dir = self.root.join(&material);
        secure_directory(&dir)?;
        for name in ["host", "identity"] {
            let path = dir.join(name);
            generate_key(&path).await?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            File::open(&path)?.sync_all()?;
            File::open(path.with_extension("pub"))?.sync_all()?;
        }
        File::open(&dir)?.sync_all()?;
        Ok(material)
    }

    fn save(&self) -> Result<()> {
        secure_write(
            &self.root.join("state.json"),
            &serde_json::to_vec(&self.journal)?,
        )
    }

    fn login(
        &self,
        target: Target,
        id: &str,
        record: &Record,
        status: &SshStatus,
    ) -> Result<Login> {
        let dir = self.material_dir(record)?;
        let alias = format!(
            "boxlite-{:x}",
            Sha256::digest(self.root.as_os_str().as_encoded_bytes())
        );
        let public = fs::read_to_string(dir.join("host.pub"))?;
        let known_hosts = dir.join("known_hosts");
        secure_write(
            &known_hosts,
            format!("{alias} {}\n", public_key(&public)).as_bytes(),
        )?;
        Login::new(target, id, dir.join("identity"), known_hosts, alias, status)
    }
}

fn public_key(value: &str) -> String {
    value
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

fn secure_directory(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error).context("Create SSH credential directory"),
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "SSH credential path must be a real directory"
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn secure_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("SSH file has no parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .map_err(|error| error.error)
        .context("Commit SSH credential record")?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

async fn generate_key(path: &Path) -> Result<()> {
    let mut child = tokio::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "boxlite", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("Run ssh-keygen; install OpenSSH client tools and ensure ssh-keygen is on PATH")?;
    let status = match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
        Ok(result) => result.context("Wait for ssh-keygen")?,
        Err(_) => {
            child.kill().await.context("Stop timed-out ssh-keygen")?;
            child.wait().await.context("Reap ssh-keygen")?;
            anyhow::bail!("ssh-keygen timed out after 15 seconds");
        }
    };
    ensure!(status.success(), "ssh-keygen failed with {status}");
    Ok(())
}
