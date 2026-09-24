//! Local configuration journal, including recovery after a lost configure reply.

use std::fs::{self, File};
use std::io::Write;
use std::net::SocketAddr;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, ensure};
use boxlite::{LiteBox, SshAccount, SshConfig, SshStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::connection::{PreparedSshConnection, Target};
use crate::cli::GlobalFlags;

const LISTEN: &str = "0.0.0.0:22";

#[derive(Clone, Serialize, Deserialize)]
struct ClientKey {
    login: String,
    material: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    material: String,
    generation: u64,
    // Absent only in records written by older CLI versions.
    #[serde(default)]
    config: Option<SshConfig>,
    #[serde(default)]
    status: Option<SshStatus>,
    #[serde(default)]
    clients: Vec<ClientKey>,
    #[serde(default)]
    login: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Journal {
    active: Option<Record>,
    pending: Option<Record>,
}

pub(super) struct Credentials {
    root: PathBuf,
    journal: Journal,
}

impl Credentials {
    pub(super) async fn configure(
        global: &GlobalFlags,
        sandbox: &LiteBox,
        config: SshConfig,
    ) -> Result<SshStatus> {
        let target = Target::resolve(global)?;
        let mut credentials = Self::open(global, &target.identity, sandbox.id())?;
        let current = sandbox.ssh().status().await?;
        let material = ulid::Ulid::new().to_string();
        secure_directory(&credentials.root.join(&material))?;
        credentials
            .submit(sandbox, material, config, &current, None)
            .await
    }

    pub(super) async fn prepare(
        global: &GlobalFlags,
        sandbox: &LiteBox,
        login: Option<&str>,
    ) -> Result<PreparedSshConnection> {
        let target = Target::resolve(global)?;
        let id = sandbox.id();
        let mut credentials = Self::open(global, &target.identity, id)?;
        let current = sandbox.ssh().status().await?;
        let mut record = if current.enabled {
            credentials.recover(&current).await?
        } else {
            let material = credentials.generate().await?;
            let config = credentials
                .generated_config(&material, login.unwrap_or("boxlite"))
                .await?;
            credentials
                .submit(sandbox, material, config, &current, login)
                .await?;
            credentials
                .journal
                .active
                .clone()
                .context("Missing confirmed SSH record")?
        };
        let status = record
            .status
            .clone()
            .context("Missing confirmed SSH status")?;
        let connection = credentials
            .connection(target, id.as_str(), &mut record, &status, login)
            .await?;
        credentials.journal.active = Some(record);
        credentials.save().context("Save selected SSH login")?;
        Ok(connection)
    }

    async fn recover(&mut self, status: &SshStatus) -> Result<Record> {
        for mut record in [self.journal.pending.clone(), self.journal.active.clone()]
            .into_iter()
            .flatten()
        {
            if record.config.is_none() {
                record.config = Some(self.generated_config(&record.material, "boxlite").await?);
                record.clients = vec![ClientKey {
                    login: "boxlite".into(),
                    material: record.material.clone(),
                }];
                record.login = Some("boxlite".into());
            }
            if self.matches(&record, status).await? {
                self.confirm(&mut record, status)?;
                return Ok(record);
            }
        }
        anyhow::bail!(
            "SSH is enabled but the saved configuration is missing or inconsistent; remote configuration preserved. Use configure to replace it, or disable before generating new keys"
        )
    }

    async fn submit(
        &mut self,
        sandbox: &LiteBox,
        material: String,
        mut config: SshConfig,
        current: &SshStatus,
        login: Option<&str>,
    ) -> Result<SshStatus> {
        let generation = current
            .generation
            .checked_add(1)
            .context("SSH generation exhausted")?;
        let dir = self.material_dir(&material)?;
        config.host_private_key = format!("{}\n", config.host_private_key.trim());
        secure_write(&dir.join("host"), config.host_private_key.as_bytes())?;
        let public = derive_public_key(&dir.join("host")).await?;
        let clients = self.find_clients(&config).await?;
        let selected = login.map(str::to_owned).or_else(|| {
            self.journal
                .active
                .as_ref()
                .and_then(|record| record.login.clone())
        });
        let mut record = Record {
            material,
            generation,
            config: Some(config.clone()),
            status: None,
            clients,
            login: selected,
        };
        self.journal.pending = Some(record.clone());
        self.save()
            .context("Save pending SSH configuration before configure")?;
        let status = sandbox.ssh().configure(config).await.context("Configure guest SSH; local configuration retained for status confirmation on the next invocation")?;
        ensure!(
            Self::matches_listener(&record, &status).context("SSH configure completed remotely but local confirmation failed; recovery material retained")?
                && Self::matches_host(&record, &status, &public),
            "SSH configure returned an unexpected identity, listener or generation; local confirmation incomplete, recovery material retained"
        );
        self.confirm(&mut record, &status)?;
        Ok(status)
    }

    fn confirm(&mut self, record: &mut Record, status: &SshStatus) -> Result<()> {
        record.status = Some(status.clone());
        self.journal.active = Some(record.clone());
        self.journal.pending = None;
        self.save().context("SSH is active remotely but local confirmation is incomplete; pending recovery material retained")
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
        let journal = match fs::read(root.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                anyhow!("Read SSH credential record: invalid JSON (credential values omitted)")
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(error) => return Err(error).context("Read SSH credential record"),
        };
        Ok(Self { root, journal })
    }

    fn material_dir(&self, material: &str) -> Result<PathBuf> {
        ensure!(
            ulid::Ulid::from_string(material).is_ok(),
            "Invalid SSH material record"
        );
        let dir = self.root.join(material);
        let metadata = fs::symlink_metadata(&dir).context("Read SSH material directory")?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "SSH credential path must be a real directory"
        );
        Ok(dir)
    }

    async fn matches(&self, record: &Record, status: &SshStatus) -> Result<bool> {
        if !Self::matches_listener(record, status)? {
            return Ok(false);
        }
        let public = derive_public_key(&self.material_dir(&record.material)?.join("host")).await?;
        Ok(Self::matches_host(record, status, &public))
    }

    fn matches_listener(record: &Record, status: &SshStatus) -> Result<bool> {
        if !status.enabled || status.generation != record.generation {
            return Ok(false);
        }
        let config = record
            .config
            .as_ref()
            .context("Missing saved SSH configuration")?;
        let expected: SocketAddr = record
            .status
            .as_ref()
            .map(|status| status.listen_address.as_str())
            .unwrap_or(&config.listen_address)
            .parse()
            .context("Invalid saved SSH listener")?;
        let actual: SocketAddr = status
            .listen_address
            .parse()
            .context("Invalid SSH status listener")?;
        Ok(expected.ip() == actual.ip()
            && actual.port() != 0
            && (expected.port() == 0 || expected.port() == actual.port()))
    }

    fn matches_host(record: &Record, status: &SshStatus, public: &str) -> bool {
        public_key(public) == public_key(&status.host_public_key)
            && record.status.as_ref().is_none_or(|saved| {
                public_key(&saved.host_public_key) == public_key(&status.host_public_key)
            })
    }

    async fn generated_config(&self, material: &str, login: &str) -> Result<SshConfig> {
        let dir = self.material_dir(material)?;
        Ok(SshConfig {
            listen_address: LISTEN.into(),
            host_private_key: fs::read_to_string(dir.join("host"))
                .context("Read saved SSH host private key")?,
            accounts: vec![SshAccount {
                login: login.into(),
                authorized_keys: vec![derive_public_key(&dir.join("identity")).await?],
                ca: None,
            }],
        })
    }

    async fn find_clients(&self, config: &SshConfig) -> Result<Vec<ClientKey>> {
        let mut clients = Vec::new();
        for entry in fs::read_dir(&self.root).context("Read saved SSH keys")? {
            let entry = entry?;
            let material = entry.file_name().to_string_lossy().into_owned();
            if ulid::Ulid::from_string(&material).is_err() {
                continue;
            }
            let dir = self.material_dir(&material)?;
            let identity = dir.join("identity");
            if !identity.try_exists()? {
                continue;
            }
            let public = match derive_public_key(&identity).await {
                Ok(public) => public,
                Err(error) => {
                    tracing::debug!(%error, "Saved SSH client key unavailable for matching");
                    continue;
                }
            };
            for account in &config.accounts {
                if account
                    .authorized_keys
                    .iter()
                    .any(|key| public_key(key) == public_key(&public))
                {
                    clients.push(ClientKey {
                        login: account.login.clone(),
                        material: material.clone(),
                    });
                }
            }
        }
        clients.sort_by(|left, right| {
            (&left.login, &left.material).cmp(&(&right.login, &right.material))
        });
        Ok(clients)
    }

    async fn generate(&self) -> Result<String> {
        let material = ulid::Ulid::new().to_string();
        let dir = self.root.join(&material);
        secure_directory(&dir)?;
        for name in ["host", "identity"] {
            let path = dir.join(name);
            generate_key(&path).await?;
            for path in [path.clone(), path.with_extension("pub")] {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
                File::open(&path)?.sync_all()?;
            }
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

    async fn connection(
        &self,
        target: Target,
        id: &str,
        record: &mut Record,
        status: &SshStatus,
        requested: Option<&str>,
    ) -> Result<PreparedSshConnection> {
        let config = record
            .config
            .as_ref()
            .context("Missing saved SSH configuration")?;
        let mut available = Vec::new();
        for client in &record.clients {
            let identity = self.material_dir(&client.material)?.join("identity");
            let public = match derive_public_key(&identity).await {
                Ok(public) => public,
                Err(_) => continue,
            };
            if config.accounts.iter().any(|account| {
                account.login == client.login
                    && account
                        .authorized_keys
                        .iter()
                        .any(|key| public_key(key) == public_key(&public))
            }) {
                available.push((client.login.clone(), identity));
            }
        }
        available.sort();
        available.dedup_by(|left, right| left.0 == right.0);
        let selected = requested.or_else(|| {
            record
                .login
                .as_deref()
                .filter(|login| available.iter().any(|(name, _)| name == login))
        });
        let (login, identity) = if let Some(selected) = selected {
            available.iter().find(|(name, _)| name == selected).cloned().context("No usable saved client credentials for selected SSH login; remote configuration preserved")?
        } else {
            ensure!(
                !available.is_empty(),
                "No usable saved client credentials for SSH; remote configuration preserved"
            );
            ensure!(
                available.len() == 1,
                "Multiple SSH logins have usable credentials; select one with --login"
            );
            available.remove(0)
        };
        let dir = self.material_dir(&record.material)?;
        let alias = format!(
            "boxlite-{:x}",
            Sha256::digest(self.root.as_os_str().as_encoded_bytes())
        );
        let known_hosts = dir.join("known_hosts");
        secure_write(
            &known_hosts,
            format!("{alias} {}\n", public_key(&status.host_public_key)).as_bytes(),
        )?;
        let connection = PreparedSshConnection::new(
            target,
            id,
            identity,
            known_hosts,
            alias,
            status,
            login.clone(),
        )?;
        record.login = Some(login);
        Ok(connection)
    }
}

async fn derive_public_key(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path).context("Read saved SSH private key")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "SSH private key must be a regular file"
    );
    let mut command = tokio::process::Command::new("ssh-keygen");
    command
        .args(["-y", "-P", "", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .context("ssh-keygen public key derivation timed out")?
        .context("Run ssh-keygen; install OpenSSH client tools and ensure ssh-keygen is on PATH")?;
    ensure!(
        output.status.success(),
        "Saved SSH private key is not usable without a passphrase"
    );
    String::from_utf8(output.stdout).context("Invalid ssh-keygen public key output")
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
