use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result, ensure};
use boxlite::SshStatus;
use serde::Serialize;

use crate::cli::GlobalFlags;

pub(super) struct Target {
    pub(super) identity: String,
    proxy_args: Vec<String>,
}

impl Target {
    pub(super) fn resolve(global: &GlobalFlags) -> Result<Self> {
        let profile = global.resolved_profile();
        let stored = global.credential_store().load_named(&profile)?;
        let options = global.resolve_rest_options(stored, None);
        let mut proxy_args = vec![utf8_path(std::env::current_exe()?)?];
        if let Some(home) = &global.home {
            proxy_args.extend(["--home".into(), utf8_path(home.clone())?]);
        }
        proxy_args.extend(["--profile".into(), profile.clone()]);
        if let Some(config) = &global.config {
            proxy_args.extend([
                "--config".into(),
                utf8_path(std::fs::canonicalize(config)?)?,
            ]);
        }
        let identity = if let Some(options) = options {
            let parsed = url::Url::parse(&options.url).context("Parse SSH target URL")?;
            ensure!(
                parsed.username().is_empty()
                    && parsed.password().is_none()
                    && parsed.query().is_none()
                    && parsed.fragment().is_none(),
                "SSH convenience commands require a target URL without userinfo, query, or fragment; use the credential profile for authentication"
            );
            proxy_args.extend(["--url".into(), options.url.clone()]);
            if let Some(prefix) = &options.path_prefix {
                proxy_args.extend(["--path-prefix".into(), prefix.clone()]);
            }
            serde_json::to_string(&(
                "rest",
                options.url.trim_end_matches('/'),
                options.path_prefix.as_deref().unwrap_or(""),
                profile,
            ))?
        } else {
            let options = global.resolve_runtime_options()?;
            let home = std::fs::canonicalize(&options.home_dir)
                .context("Resolve local runtime directory")?;
            serde_json::to_string(&("local", home))?
        };
        Ok(Self {
            identity,
            proxy_args,
        })
    }
}

#[derive(Serialize)]
pub(super) struct Login {
    box_id: String,
    login: &'static str,
    port: u16,
    identity_file: PathBuf,
    known_hosts_file: PathBuf,
    host_key_fingerprint: String,
    command: String,
    #[serde(skip)]
    alias: String,
    #[serde(skip)]
    proxy: Option<String>,
    #[serde(skip)]
    hostname: String,
}

impl Login {
    pub(super) fn new(
        target: Target,
        id: &str,
        identity_file: PathBuf,
        known_hosts_file: PathBuf,
        alias: String,
        status: &SshStatus,
    ) -> Result<Self> {
        let mut proxy_args = target.proxy_args;
        proxy_args.extend([
            "network".into(),
            "tunnel".into(),
            id.into(),
            "22".into(),
            "--stdio".into(),
        ]);
        // OpenSSH expands percent tokens before the user's shell parses
        // ProxyCommand. Both languages must be escaped, in that order.
        let proxy = format!("exec {}", shell_command(&proxy_args)).replace('%', "%%");
        let mut login = Self {
            box_id: id.into(),
            login: "boxlite",
            port: 22,
            identity_file,
            known_hosts_file,
            host_key_fingerprint: status.host_key_fingerprint.clone(),
            command: String::new(),
            alias,
            proxy: Some(proxy),
            hostname: "boxlite".into(),
        };
        login.refresh_command()?;
        Ok(login)
    }

    pub(super) fn use_listener(&mut self, address: SocketAddr) -> Result<()> {
        self.proxy = None;
        self.hostname = address.ip().to_string();
        self.port = address.port();
        self.refresh_command()
    }

    fn args(&self) -> Result<Vec<String>> {
        let identity = config_string(&utf8_path(self.identity_file.clone())?);
        let known_hosts = config_string(&utf8_path(self.known_hosts_file.clone())?);
        let mut args = vec![
            "-F".into(),
            "/dev/null".into(),
            "-o".into(),
            "StrictHostKeyChecking=yes".into(),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
            "-o".into(),
            "PasswordAuthentication=no".into(),
            "-o".into(),
            "KbdInteractiveAuthentication=no".into(),
            "-o".into(),
            "GlobalKnownHostsFile=/dev/null".into(),
            "-o".into(),
            format!("UserKnownHostsFile={known_hosts}"),
            "-o".into(),
            format!("HostKeyAlias={}", self.alias),
            "-o".into(),
            format!("IdentityFile={identity}"),
            "-p".into(),
            self.port.to_string(),
        ];
        if let Some(proxy) = &self.proxy {
            args.extend(["-o".into(), format!("ProxyCommand={proxy}")]);
        }
        args.extend(["-l".into(), self.login.into(), self.hostname.clone()]);
        Ok(args)
    }

    fn refresh_command(&mut self) -> Result<()> {
        let mut command = vec!["ssh".into()];
        command.extend(self.args()?);
        self.command = shell_command(&command);
        Ok(())
    }

    pub(super) async fn connect(&self, command: &[String]) -> Result<i32> {
        let mut args = self.args()?;
        if !command.is_empty() {
            args.push(shell_command(command));
        }
        let mut child = tokio::process::Command::new("ssh")
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("Run system ssh; install OpenSSH client tools and ensure ssh is on PATH")?;
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let status = tokio::select! {
            status = child.wait() => status.context("Wait for system ssh")?,
            signal = tokio::signal::ctrl_c() => {
                signal.context("Wait for Ctrl-C")?;
                stop_ssh(&mut child).await?;
                return Ok(130);
            }
            _ = terminate.recv() => {
                stop_ssh(&mut child).await?;
                return Ok(143);
            }
        };
        use std::os::unix::process::ExitStatusExt;
        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
    }
}

async fn stop_ssh(child: &mut tokio::process::Child) -> Result<()> {
    // Give OpenSSH its normal cleanup path so it also terminates ProxyCommand.
    if let Some(pid) = child.id() {
        match nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        ) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => (),
            Err(error) => return Err(error).context("Terminate system ssh"),
        }
    }
    match tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await {
        Ok(result) => {
            result.context("Reap system ssh")?;
        }
        Err(_) => {
            child.kill().await.context("Kill unresponsive system ssh")?;
            child.wait().await.context("Reap system ssh")?;
        }
    }
    Ok(())
}

fn utf8_path(path: PathBuf) -> Result<String> {
    path.into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("OpenSSH command paths must be UTF-8"))
}

fn config_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

fn shell_command(args: &[String]) -> String {
    args.iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}
