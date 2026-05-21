//! CLI definition and argument parsing for boxlite-cli.
//! This module contains all CLI-related code including the main CLI structure,
//! subcommands, and flag definitions.

use boxlite::runtime::options::{PortProtocol, PortSpec, VolumeSpec};
use boxlite::{
    BoxCommand, BoxOptions, BoxliteOptions, BoxliteRestOptions, BoxliteRuntime, ImageRegistry,
};
use clap::{Args, Command, Parser, Subcommand, ValueEnum};
use clap_complete::shells::{Bash, Fish, Zsh};
use std::io::{IsTerminal, Write};
use std::path::Path;

/// Helper to parse CLI environment variables and apply them to BoxOptions
pub fn apply_env_vars(env: &[String], opts: &mut BoxOptions) {
    apply_env_vars_with_lookup(env, opts, |k| std::env::var(k).ok())
}

/// Helper to parse CLI environment variables with custom lookup for host variables
pub fn apply_env_vars_with_lookup<F>(env: &[String], opts: &mut BoxOptions, lookup: F)
where
    F: Fn(&str) -> Option<String>,
{
    for env_str in env {
        if let Some((k, v)) = env_str.split_once('=') {
            opts.env.push((k.to_string(), v.to_string()));
        } else if let Some(val) = lookup(env_str) {
            opts.env.push((env_str.to_string(), val));
        } else {
            tracing::warn!(
                "Environment variable '{}' not found on host, skipping",
                env_str
            );
        }
    }
}

// ============================================================================
// CLI Definition
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "boxlite", author, version, about = "BoxLite CLI")]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalFlags,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
#[non_exhaustive]
pub enum Commands {
    Run(crate::commands::run::RunArgs),
    /// Execute a command in a running box
    Exec(crate::commands::exec::ExecArgs),
    /// Create a new box
    Create(crate::commands::create::CreateArgs),

    /// List boxes
    #[command(visible_alias = "ls", visible_alias = "ps")]
    List(crate::commands::list::ListArgs),

    /// Remove one or more boxes
    Rm(crate::commands::rm::RmArgs),

    /// Start one or more stopped boxes
    Start(crate::commands::start::StartArgs),

    /// Stop one or more running boxes
    Stop(crate::commands::stop::StopArgs),

    /// Restart one or more boxes
    Restart(crate::commands::restart::RestartArgs),

    /// Pull an image from a registry
    Pull(crate::commands::pull::PullArgs),

    /// List images
    Images(crate::commands::images::ImagesArgs),

    /// Display detailed information on a box
    Inspect(crate::commands::inspect::InspectArgs),

    /// Copy files/folders between host and box
    Cp(crate::commands::cp::CpArgs),

    /// Display system-wide runtime information
    Info(crate::commands::info::InfoArgs),

    /// Show logs from a box
    Logs(crate::commands::logs::LogsArgs),

    /// Display resource usage statistics for a box
    Stats(crate::commands::stats::StatsArgs),

    /// Start a long-running REST API server
    Serve(crate::commands::serve::ServeArgs),

    /// Authenticate with a remote BoxLite server
    Auth(crate::commands::auth::AuthArgs),

    /// Generate shell completion script (hidden from help)
    #[command(hide = true)]
    Completion(CompletionArgs),
}

/// Shell for which to generate completion script.
#[derive(ValueEnum, Clone, Debug)]
#[value(rename_all = "lower")]
pub enum Shell {
    Bash,
    Zsh,
    Fish,
}

/// Arguments for the completion subcommand.
#[derive(Args, Debug)]
pub struct CompletionArgs {
    /// Shell to generate completion for (bash, zsh, fish).
    pub shell: Shell,
}

/// Writes a completion script for the given shell to `out`.
pub fn generate_completion(shell: &Shell, cmd: &mut Command, name: &str, out: &mut dyn Write) {
    match shell {
        Shell::Bash => clap_complete::generate(Bash, cmd, name, out),
        Shell::Zsh => clap_complete::generate(Zsh, cmd, name, out),
        Shell::Fish => clap_complete::generate(Fish, cmd, name, out),
    }
}

// ============================================================================
// GLOBAL FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct GlobalFlags {
    /// Enable debug output
    #[arg(long, global = true)]
    pub debug: bool,

    /// BoxLite home directory
    #[arg(long, global = true, env = "BOXLITE_HOME")]
    pub home: Option<std::path::PathBuf>,

    /// Image registry to use (can be specified multiple times)
    #[arg(long, global = true, value_name = "REGISTRY")]
    pub registry: Vec<String>,

    /// Configuration file path (optional)
    ///
    /// Specifies the JSON configuration file containing BoxLite options such as image_registries.
    /// If not provided, uses default options (no config file is loaded from $BOXLITE_HOME).
    #[arg(long, global = true)]
    pub config: Option<String>,

    /// Connect to a remote BoxLite REST API server instead of local runtime.
    #[arg(long, global = true, env = "BOXLITE_REST_URL")]
    pub url: Option<String>,
}

impl GlobalFlags {
    /// Resolve runtime options from config file and CLI overrides (--home, --registry).
    pub fn resolve_runtime_options(&self) -> anyhow::Result<BoxliteOptions> {
        let mut options = if let Some(config_path) = &self.config {
            crate::config::load_config(Path::new(config_path))?
        } else {
            BoxliteOptions::default()
        };

        if let Some(cli_home) = &self.home {
            options.home_dir = cli_home.clone();
        }

        if !self.registry.is_empty() {
            options.image_registries = self
                .registry
                .iter()
                .map(|host| ImageRegistry::https(host).with_search(true))
                .chain(options.image_registries)
                .collect();
        }

        Ok(options)
    }

    /// Create a runtime from pre-resolved options (avoids resolving twice when caller already has options).
    pub fn create_runtime_with_options(
        &self,
        options: BoxliteOptions,
    ) -> anyhow::Result<BoxliteRuntime> {
        BoxliteRuntime::new(options).map_err(Into::into)
    }

    pub fn create_runtime(&self) -> anyhow::Result<BoxliteRuntime> {
        // URL precedence: --url / BOXLITE_REST_URL (the clap flag covers both) > stored profile > none.
        // Credential precedence: BOXLITE_API_KEY env > stored profile > none.
        // Clap reads BOXLITE_REST_URL into `self.url`, so we don't re-check env here.
        let stored = crate::credentials::load().ok().flatten();

        let url = self
            .url
            .clone()
            .or_else(|| stored.as_ref().map(|p| p.url.clone()));

        let Some(url) = url else {
            // No URL anywhere → local runtime, unchanged behavior.
            let options = self.resolve_runtime_options()?;
            return self.create_runtime_with_options(options);
        };

        let mut opts = BoxliteRestOptions::new(url);

        // BOXLITE_API_KEY env beats stored credentials of any kind.
        if let Ok(key) = std::env::var("BOXLITE_API_KEY")
            && !key.is_empty()
        {
            opts = opts.with_api_key(key);
        } else if let Some(profile) = stored {
            opts = crate::credentials::into_rest_options(profile);
            // The conversion above also sets the URL from the profile; the
            // caller's --url already won via the precedence check above, so
            // re-apply it to make sure it wins over the stored URL.
            opts.url = self.url.clone().unwrap_or(opts.url);
        }

        BoxliteRuntime::rest(opts).map_err(Into::into)
    }
}

// ============================================================================
// PROCESS FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ProcessFlags {
    /// Keep STDIN open even if not attached
    #[arg(short, long)]
    pub interactive: bool,

    /// Allocate a pseudo-TTY (stdout and stderr are merged in TTY mode)
    #[arg(short, long)]
    pub tty: bool,

    /// Set environment variables
    #[arg(short = 'e', long = "env")]
    pub env: Vec<String>,

    /// Working directory inside the box
    #[arg(short = 'w', long = "workdir")]
    pub workdir: Option<String>,

    /// User to run the command as (format: <name|uid>[:<group|gid>])
    #[arg(short = 'u', long = "user")]
    pub user: Option<String>,
}

impl ProcessFlags {
    /// Apply process configuration to BoxOptions
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        self.apply_to_with_lookup(opts, |k| std::env::var(k).ok())
    }

    /// Internal helper for dependency injection of environment variables
    fn apply_to_with_lookup<F>(&self, opts: &mut BoxOptions, lookup: F) -> anyhow::Result<()>
    where
        F: Fn(&str) -> Option<String>,
    {
        opts.working_dir = self.workdir.clone();
        apply_env_vars_with_lookup(&self.env, opts, lookup);
        Ok(())
    }

    /// Validate process flags
    pub fn validate(&self, detach: bool) -> anyhow::Result<()> {
        // Check TTY mode only in non-detach mode
        if !detach && self.tty && !std::io::stdin().is_terminal() {
            anyhow::bail!("the input device is not a TTY.");
        }

        Ok(())
    }

    /// Configures a BoxCommand with process flags (env, workdir, tty)
    pub fn configure_command(&self, mut cmd: BoxCommand) -> BoxCommand {
        for env_str in &self.env {
            if let Some((k, v)) = env_str.split_once('=') {
                cmd = cmd.env(k, v);
            } else if let Ok(val) = std::env::var(env_str) {
                cmd = cmd.env(env_str, val);
            }
        }

        if let Some(ref w) = self.workdir {
            cmd = cmd.working_dir(w);
        }

        if self.tty {
            cmd = cmd.tty(true);
        }

        if let Some(ref user) = self.user {
            cmd = cmd.user(user);
        }

        cmd
    }
}

// ============================================================================
// RESOURCE FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ResourceFlags {
    /// Number of CPUs
    #[arg(long)]
    pub cpus: Option<u32>,

    /// Memory limit (in MiB)
    #[arg(long)]
    pub memory: Option<u32>,
}

impl ResourceFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        if let Some(cpus) = self.cpus {
            if cpus > 255 {
                tracing::warn!("CPU limit capped at 255 (requested {})", cpus);
            }
            opts.cpus = Some(cpus.min(255) as u8);
        }
        if let Some(mem) = self.memory {
            opts.memory_mib = Some(mem);
        }
    }
}

// ============================================================================
// PUBLISH (PORT) FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct PublishFlags {
    /// Publish a box port to the host (format: [hostPort:]boxPort[/tcp|udp], e.g. 18789:18789)
    #[arg(short = 'p', long = "publish", value_name = "PORT")]
    pub publish: Vec<String>,
}

impl PublishFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        for s in &self.publish {
            let spec = parse_publish_spec(s)?;
            if matches!(spec.protocol, PortProtocol::Udp) {
                eprintln!(
                    "Warning: UDP port forwarding is not yet implemented; {} will be forwarded as TCP",
                    s
                );
            }
            opts.ports.push(spec);
        }
        Ok(())
    }
}

/// Parse a single publish spec: `[hostPort:]boxPort[/tcp|udp]`.
/// - `boxPort` → host_port=None, guest_port=boxPort
/// - `hostPort:boxPort` → host_port=Some(hostPort), guest_port=boxPort
///
/// Only TCP is forwarded by the runtime today; UDP is accepted but not yet implemented.
fn parse_publish_spec(s: &str) -> anyhow::Result<PortSpec> {
    let s = s.trim();
    if s.is_empty() {
        anyhow::bail!("empty port spec");
    }
    let (rest, protocol) = match s.split_once('/') {
        Some((r, proto)) => {
            let p = if proto.eq_ignore_ascii_case("tcp") {
                PortProtocol::Tcp
            } else if proto.eq_ignore_ascii_case("udp") {
                PortProtocol::Udp
            } else {
                anyhow::bail!("invalid protocol {:?}; use tcp or udp", proto)
            };
            (r.trim(), p)
        }
        None => (s, PortProtocol::Tcp),
    };
    let parts: Vec<&str> = rest.splitn(2, ':').map(str::trim).collect();
    let (host_port, guest_port) = match parts.as_slice() {
        [guest] => {
            let g = parse_port(guest)?;
            (None, g)
        }
        [host, guest] => {
            let h = parse_port(host)?;
            let g = parse_port(guest)?;
            (Some(h), g)
        }
        _ => anyhow::bail!(
            "invalid port spec {:?}; use hostPort:boxPort or boxPort[/tcp]",
            s
        ),
    };
    Ok(PortSpec {
        host_port,
        guest_port,
        protocol,
        host_ip: None,
    })
}

fn parse_port(s: &str) -> anyhow::Result<u16> {
    let n: u16 = s
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid port number {:?}", s))?;
    if n == 0 {
        anyhow::bail!("port must be 1-65535");
    }
    Ok(n)
}

// ============================================================================
// VOLUME FLAGS
// ============================================================================

/// Result of parsing a volume spec. Anonymous volumes have host_path = None.
struct ParsedVolumeSpec {
    host_path: Option<String>,
    guest_path: String,
    read_only: bool,
}

#[derive(Args, Debug, Clone)]
pub struct VolumeFlags {
    /// Mount a volume (format: hostPath:boxPath[:options], or boxPath for anonymous volume, e.g. /data:/app/data, /data:ro)
    #[arg(short = 'v', long = "volume", value_name = "VOLUME")]
    pub volume: Vec<String>,
}

/// True if the segment is a single ASCII letter (Windows drive, e.g. "C" in "C:\path").
fn is_windows_drive(segment: &str) -> bool {
    let s = segment.trim();
    s.len() == 1
        && s.chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
}

/// True if path looks like a Windows absolute path (e.g. `C:\foo` or `D:/bar`).
fn is_windows_absolute_path(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Parse options string (e.g. "ro" or "rw,nocopy") and return read_only. Other options are ignored.
fn parse_volume_read_only(opts: &str) -> bool {
    opts.split(',').any(|o| o.trim().eq_ignore_ascii_case("ro"))
}

/// Parse a single volume spec.
/// - Anonymous : `boxPath` or `boxPath:ro` (e.g. `/data`, `/data:ro`).
/// - Bind mount: `hostPath:boxPath[:options]` (e.g. `/data:/app/data`, `/data:/app/data:ro`).
///
/// Options: `ro` (read-only), `rw` (read-write, default). Other options are ignored.
///   Windows: host path may be a drive path like `C:\data`; the colon after the drive letter is not
///   treated as a separator (e.g. `C:\data:/app/data` → host=`C:\data`, guest=`/app/data`).
fn parse_volume_spec(s: &str) -> anyhow::Result<ParsedVolumeSpec> {
    let s = s.trim();
    if s.is_empty() {
        anyhow::bail!("empty volume spec");
    }
    let parts: Vec<&str> = s.split(':').map(str::trim).collect();

    let (host_path, guest_path, read_only) = match parts.len() {
        1 => {
            // Anonymous volume: box path only (e.g. /data)
            let guest = parts[0].to_string();
            if guest.is_empty() {
                anyhow::bail!("volume box path must be non-empty");
            }
            if !guest.starts_with('/') && !is_windows_drive(parts[0]) {
                anyhow::bail!(
                    "anonymous volume box path must be absolute (e.g. /data), got {:?}",
                    guest
                );
            }
            (None, guest, false)
        }
        2 => {
            // Either anonymous with options (guest:ro) or bind (host:guest)
            let second = parts[1];
            if second.eq_ignore_ascii_case("ro") || second.eq_ignore_ascii_case("rw") {
                let guest = parts[0].to_string();
                if guest.is_empty() {
                    anyhow::bail!("volume box path must be non-empty");
                }
                (None, guest, second.eq_ignore_ascii_case("ro"))
            } else {
                (Some(parts[0].to_string()), parts[1].to_string(), false)
            }
        }
        3 => {
            if is_windows_drive(parts[0]) {
                let host = format!("{}:{}", parts[0], parts[1]);
                (Some(host), parts[2].to_string(), false)
            } else {
                let ro = parse_volume_read_only(parts[2]);
                (Some(parts[0].to_string()), parts[1].to_string(), ro)
            }
        }
        4.. => {
            if is_windows_drive(parts[0]) {
                let host = format!("{}:{}", parts[0], parts[1]);
                let ro = parse_volume_read_only(parts[3]);
                (Some(host), parts[2].to_string(), ro)
            } else {
                anyhow::bail!(
                    "invalid volume spec {:?}; use hostPath:boxPath[:options] (e.g. /data:/app/data or C:\\data:/app/data:ro)",
                    s
                );
            }
        }
        _ => {
            anyhow::bail!(
                "invalid volume spec {:?}; use hostPath:boxPath[:options] or boxPath[:options] for anonymous volume",
                s
            );
        }
    };

    if let Some(ref host) = host_path
        && host.is_empty()
    {
        anyhow::bail!("volume host path must be non-empty");
    }
    if guest_path.is_empty() {
        anyhow::bail!("volume box path must be non-empty");
    }
    Ok(ParsedVolumeSpec {
        host_path,
        guest_path,
        read_only,
    })
}

/// Resolve base directory for anonymous volumes: explicit home, or BOXLITE_HOME, or ~/.boxlite, or temp dir.
fn anonymous_volume_base(home: Option<&std::path::Path>) -> std::path::PathBuf {
    home.map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var("BOXLITE_HOME")
                .ok()
                .map(std::path::PathBuf::from)
        })
        .or_else(|| {
            dirs::home_dir().map(|mut p| {
                p.push(".boxlite");
                p
            })
        })
        .unwrap_or_else(std::env::temp_dir)
}

impl VolumeFlags {
    /// Apply volume flags to options. Pass `home` for anonymous volume storage (e.g. from GlobalFlags).
    pub fn apply_to(
        &self,
        opts: &mut BoxOptions,
        home: Option<&std::path::Path>,
    ) -> anyhow::Result<()> {
        let base = anonymous_volume_base(home);
        for s in self.volume.iter() {
            let spec = parse_volume_spec(s)?;
            let host_path = match spec.host_path {
                Some(host) => {
                    let mut path = host;
                    if std::path::Path::new(&path).is_relative() && !is_windows_absolute_path(&path)
                    {
                        let abs = std::fs::canonicalize(&path)
                            .map_err(|e| anyhow::anyhow!("volume host path {:?}: {}", path, e))?;
                        path = abs.to_string_lossy().into_owned();
                    }
                    path
                }
                None => {
                    // Anonymous volume: use a random ID for the directory name (same approach as
                    // Podman: cryptographically random ID to avoid collisions under any load).
                    let unique = ulid::Ulid::new().to_string();
                    let dir = base.join("volumes").join("anonymous").join(unique);
                    std::fs::create_dir_all(&dir).map_err(|e| {
                        anyhow::anyhow!("failed to create anonymous volume dir {:?}: {}", dir, e)
                    })?;
                    dir.to_string_lossy().into_owned()
                }
            };
            opts.volumes.push(VolumeSpec {
                host_path,
                guest_path: spec.guest_path,
                read_only: spec.read_only,
            });
        }
        Ok(())
    }
}

// ============================================================================
// MANAGEMENT FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ManagementFlags {
    /// Assign a name to the box
    #[arg(long)]
    pub name: Option<String>,

    /// Run the box in the background (detach)
    #[arg(short = 'd', long)]
    pub detach: bool,

    /// Automatically remove the box when it exits
    #[arg(long)]
    pub rm: bool,

    /// Override the image's ENTRYPOINT directive.
    ///
    /// When set, completely replaces the image's ENTRYPOINT for the box's
    /// init process. Useful for images with an ENTRYPOINT that exits
    /// (e.g., `docker:dind`'s `dockerd-entrypoint.sh` finishes its TLS
    /// setup and exits when given no `dockerd` arg → tears down the
    /// container's PID namespace and kills all exec'd processes).
    /// Pair with the positional `[COMMAND...]` arg, which becomes the
    /// args to this entrypoint.
    #[arg(long, value_name = "PROGRAM")]
    pub entrypoint: Option<String>,

    /// Pass arguments to the image's ENTRYPOINT (Docker CMD override).
    ///
    /// Repeatable; each `--cmd ARG` adds one positional argument that the
    /// image's existing ENTRYPOINT receives as `$1`, `$2`, ... Use this
    /// when you want the image's init to run with custom flags but
    /// without replacing it (the way `--entrypoint` does).
    ///
    /// Gated on `--privileged`: the lean / non-docker `boxlite run`
    /// flow has long treated `[COMMAND...]` as a secondary-exec attach
    /// rather than CMD, so introducing CMD overrides outside the docker
    /// opt-in would silently re-route stdio for every existing user. The
    /// gate keeps default behaviour byte-for-byte identical.
    ///
    /// Example — pass an extra log-level flag to `docker:dind`'s own
    /// `dockerd-entrypoint.sh`:
    ///   `boxlite run --privileged --cmd --log-level=debug docker:dind`
    #[arg(
        long = "cmd",
        value_name = "ARG",
        allow_hyphen_values = true,
        conflicts_with = "entrypoint"
    )]
    pub cmd: Vec<String>,

    /// Enable in-box docker / docker-compose support.
    ///
    /// Mounts /sys/fs/cgroup as writable cgroup2 inside the container and
    /// grants the full Linux capability set (CAP_SYS_ADMIN, CAP_NET_ADMIN,
    /// CAP_SYS_MODULE, etc.) to the container init plus every exec'd
    /// process. Equivalent to `docker run --privileged` for the in-box
    /// container.
    ///
    /// SECURITY: this widens the in-VM attack surface significantly — any
    /// process inside the box runs effectively as root with full caps and
    /// can mount/remount filesystems, manipulate network/iptables, and use
    /// every cap-gated kernel API. The microVM boundary still contains
    /// the process (host stays protected by KVM/libkrun isolation), but
    /// only enable this for trusted workloads or where you would already
    /// be running `docker run --privileged`. Default is OFF and existing
    /// boxes are unaffected.
    #[arg(long)]
    pub privileged: bool,
}

impl ManagementFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        opts.detach = self.detach;
        opts.auto_remove = self.rm;
        opts.privileged = self.privileged;
        if let Some(ep) = &self.entrypoint {
            opts.entrypoint = Some(vec![ep.clone()]);
        }
        // `--cmd` is gated on `--privileged` so a stray `--cmd` flag
        // without the docker opt-in stays a no-op rather than silently
        // changing CMD for the lean flow. The CLI command's
        // `validate_flags` rejects that combination at parse-time, but
        // we double-check here so direct callers (e.g., tests building
        // ManagementFlags by hand) cannot accidentally widen behaviour.
        if self.privileged && !self.cmd.is_empty() {
            opts.cmd = Some(self.cmd.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ─── --privileged flag plumbing ────────────────────────────────
    //
    // The CLI flag must default to false and only flip BoxOptions when the
    // user explicitly passes it. The proto + guest paths take care of the
    // rest; what THIS module is responsible for is the CLI→BoxOptions hop.
    // Tests below guard both the default-off invariant (existing users see
    // no behaviour change) and the explicit-on plumbing.

    #[test]
    fn management_flags_default_leaves_privileged_false() {
        // Build a minimal ManagementFlags with only the unrelated fields the
        // user might set in everyday `boxlite run` invocations.
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            entrypoint: None,
            cmd: vec![],
            privileged: false,
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);
        assert!(
            !opts.privileged,
            "BoxOptions.privileged must stay false when --privileged \
             is NOT passed — protects every existing user from a silent \
             attack-surface widening"
        );
    }

    #[test]
    fn management_flags_propagates_privileged_when_set() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            entrypoint: None,
            cmd: vec![],
            privileged: true,
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);
        assert!(
            opts.privileged,
            "--privileged must flip BoxOptions.privileged so the \
             guest receives the relaxed-caps + cgroup-rw profile"
        );
    }

    #[test]
    fn management_flags_apply_does_not_clobber_unrelated_options() {
        // Setting --privileged must NOT silently change any other
        // BoxOptions field. Verify by populating the options with non-default
        // values for fields ManagementFlags doesn't own, applying the flag,
        // and asserting they're preserved.
        let mut opts = BoxOptions {
            cpus: Some(4),
            memory_mib: Some(2048),
            entrypoint: Some(vec!["dockerd".to_string()]),
            ..BoxOptions::default()
        };

        let flags = ManagementFlags {
            name: None,
            detach: true,
            rm: true,
            entrypoint: None,
            cmd: vec![],
            privileged: true,
        };
        flags.apply_to(&mut opts);

        assert_eq!(opts.cpus, Some(4), "cpus must not be clobbered");
        assert_eq!(
            opts.memory_mib,
            Some(2048),
            "memory_mib must not be clobbered"
        );
        assert_eq!(
            opts.entrypoint,
            Some(vec!["dockerd".to_string()]),
            "entrypoint must not be clobbered"
        );
        // What ManagementFlags DOES own should be updated.
        assert!(opts.detach);
        assert!(opts.auto_remove);
        assert!(opts.privileged);
    }

    // ─── --cmd flag plumbing ───────────────────────────────────────────
    //
    // `--cmd` carries args for the image's existing ENTRYPOINT. It is
    // strictly opt-in via `--privileged` so the lean / non-docker
    // `boxlite run` flow (where positional `[COMMAND...]` is a secondary
    // exec attach, not Docker CMD) keeps its semantics unchanged. The
    // tests below pin both halves of that contract:
    //   1. `--cmd` without `--privileged` is a no-op at the
    //      apply_to layer (the run command also rejects this combo at
    //      validate-time, but apply_to is the last line of defence for
    //      any direct callers).
    //   2. `--cmd` with `--privileged` populates BoxOptions::cmd.

    #[test]
    fn management_flags_cmd_without_privileged_is_noop() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            entrypoint: None,
            cmd: vec!["--bridge=none".to_string()],
            privileged: false,
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);
        assert!(
            opts.cmd.is_none(),
            "--cmd must not affect BoxOptions when --privileged is OFF"
        );
    }

    #[test]
    fn management_flags_cmd_with_privileged_sets_cmd() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            entrypoint: None,
            cmd: vec![
                "--bridge=none".to_string(),
                "--iptables=false".to_string(),
                "--storage-driver=vfs".to_string(),
            ],
            privileged: true,
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);
        assert_eq!(
            opts.cmd.as_deref(),
            Some(
                &[
                    "--bridge=none".to_string(),
                    "--iptables=false".to_string(),
                    "--storage-driver=vfs".to_string(),
                ][..]
            ),
            "--cmd args must propagate verbatim to BoxOptions.cmd, in order"
        );
    }

    #[test]
    fn management_flags_empty_cmd_does_not_overwrite_existing() {
        // Pre-existing BoxOptions::cmd (e.g., set by a config file the CLI
        // loads before applying flags) must not be wiped by an unset --cmd.
        let mut opts = BoxOptions {
            cmd: Some(vec!["preserved".to_string()]),
            ..BoxOptions::default()
        };
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            entrypoint: None,
            cmd: vec![],
            privileged: true,
        };
        flags.apply_to(&mut opts);
        assert_eq!(
            opts.cmd,
            Some(vec!["preserved".to_string()]),
            "an empty --cmd Vec must leave a previously-set cmd untouched"
        );
    }

    #[test]
    fn box_options_default_has_privileged_false() {
        // The default constructor is the source of truth for "lean profile".
        // Multiple SDK plumbings rely on this default; guard it here so any
        // accidental change tips a unit test instead of silently shipping
        // a new default behaviour to every box on the planet.
        let opts = BoxOptions::default();
        assert!(
            !opts.privileged,
            "BoxOptions::default().privileged MUST be false. Changing this \
             default would silently widen attack surface for every existing user."
        );
    }

    #[test]
    fn test_apply_env_vars_with_lookup() {
        let mut opts = BoxOptions::default();
        let current_env = vec![
            "TEST_VAR=test_value".to_string(),
            "TEST_HOST_VAR".to_string(),
            "NON_EXISTENT_VAR".to_string(),
        ];

        apply_env_vars_with_lookup(&current_env, &mut opts, |k| {
            if k == "TEST_HOST_VAR" {
                Some("host_value".to_string())
            } else {
                None
            }
        });

        assert!(
            opts.env
                .contains(&("TEST_VAR".to_string(), "test_value".to_string()))
        );

        assert!(
            opts.env
                .contains(&("TEST_HOST_VAR".to_string(), "host_value".to_string()))
        );

        assert!(!opts.env.iter().any(|(k, _)| k == "NON_EXISTENT_VAR"));
    }

    #[test]
    fn resolve_runtime_options_prepends_cli_registries_to_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.json");
        fs::write(
            &config_path,
            r#"{
                "image_registries": [
                    {
                        "host": "registry.local:5000",
                        "transport": "http",
                        "search": true
                    }
                ]
            }"#,
        )
        .unwrap();

        let flags = GlobalFlags {
            debug: false,
            home: Some(temp_dir.path().join("home")),
            registry: vec!["cli.registry.local".to_string()],
            config: Some(config_path.display().to_string()),
            url: None,
        };

        let options = flags.resolve_runtime_options().unwrap();

        assert_eq!(options.home_dir, temp_dir.path().join("home"));
        assert_eq!(
            options.image_registries,
            vec![
                ImageRegistry::https("cli.registry.local").with_search(true),
                ImageRegistry::http("registry.local:5000").with_search(true),
            ]
        );
    }

    #[test]
    fn test_resource_flags_cpu_cap() {
        let flags = ResourceFlags {
            cpus: Some(1000),
            memory: None,
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        assert_eq!(opts.cpus, Some(255));
    }

    #[test]
    fn test_parse_publish_spec_host_box() {
        let spec = super::parse_publish_spec("18789:18789").unwrap();
        assert_eq!(spec.host_port, Some(18789));
        assert_eq!(spec.guest_port, 18789);
        assert!(matches!(spec.protocol, PortProtocol::Tcp));
    }

    #[test]
    fn test_parse_publish_spec_host_box_tcp() {
        let spec = super::parse_publish_spec("8080:80/tcp").unwrap();
        assert_eq!(spec.host_port, Some(8080));
        assert_eq!(spec.guest_port, 80);
        assert!(matches!(spec.protocol, PortProtocol::Tcp));
    }

    #[test]
    fn test_parse_publish_spec_box_only() {
        let spec = super::parse_publish_spec("80").unwrap();
        assert_eq!(spec.host_port, None);
        assert_eq!(spec.guest_port, 80);
    }

    #[test]
    fn test_parse_publish_spec_udp() {
        let spec = super::parse_publish_spec("53:53/udp").unwrap();
        assert_eq!(spec.host_port, Some(53));
        assert_eq!(spec.guest_port, 53);
        assert!(matches!(spec.protocol, PortProtocol::Udp));
    }

    #[test]
    fn test_parse_publish_spec_invalid_protocol() {
        assert!(super::parse_publish_spec("80:80/sctp").is_err());
    }

    #[test]
    fn test_parse_publish_spec_invalid_port() {
        assert!(super::parse_publish_spec("0:80").is_err());
        assert!(super::parse_publish_spec("99999:80").is_err());
    }

    #[test]
    fn test_publish_flags_apply_to() {
        let flags = PublishFlags {
            publish: vec!["18789:18789".to_string(), "8080:80/tcp".to_string()],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts).unwrap();
        assert_eq!(opts.ports.len(), 2);
        assert_eq!(opts.ports[0].host_port, Some(18789));
        assert_eq!(opts.ports[0].guest_port, 18789);
        assert_eq!(opts.ports[1].host_port, Some(8080));
        assert_eq!(opts.ports[1].guest_port, 80);
    }

    #[test]
    fn test_parse_volume_spec_host_guest() {
        let spec = super::parse_volume_spec("/data:/app/data").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some("/data"));
        assert_eq!(spec.guest_path, "/app/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_read_only() {
        let spec = super::parse_volume_spec("/data:/app/data:ro").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some("/data"));
        assert_eq!(spec.guest_path, "/app/data");
        assert!(spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_rw_explicit() {
        let spec = super::parse_volume_spec("/data:/app/data:rw").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some("/data"));
        assert_eq!(spec.guest_path, "/app/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_anonymous() {
        let spec = super::parse_volume_spec("/data").unwrap();
        assert!(spec.host_path.is_none());
        assert_eq!(spec.guest_path, "/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_anonymous_ro() {
        let spec = super::parse_volume_spec("/data:ro").unwrap();
        assert!(spec.host_path.is_none());
        assert_eq!(spec.guest_path, "/data");
        assert!(spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_anonymous_relative_invalid() {
        assert!(super::parse_volume_spec("data").is_err());
    }

    #[test]
    fn test_parse_volume_spec_invalid_empty_parts() {
        assert!(super::parse_volume_spec(":/app").is_err());
        assert!(super::parse_volume_spec("/data:").is_err());
    }

    // --- Windows drive compatibility ---

    #[test]
    fn test_parse_volume_spec_windows_drive_two_parts() {
        // "C:\data:/app/data" → host=C:\data, guest=/app/data (3 segments after split)
        let spec = super::parse_volume_spec(r"C:\data:/app/data").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some(r"C:\data"));
        assert_eq!(spec.guest_path, "/app/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_windows_drive_with_ro() {
        // "C:\data:/app/data:ro" → 4 segments
        let spec = super::parse_volume_spec(r"C:\data:/app/data:ro").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some(r"C:\data"));
        assert_eq!(spec.guest_path, "/app/data");
        assert!(spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_windows_drive_with_rw() {
        let spec = super::parse_volume_spec(r"D:\path:/mnt:rw").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some(r"D:\path"));
        assert_eq!(spec.guest_path, "/mnt");
        assert!(!spec.read_only);
    }

    #[test]
    fn test_parse_volume_spec_windows_drive_long_path() {
        // "D:\host\path:/app" → host=D:\host\path, guest=/app
        let spec = super::parse_volume_spec(r"D:\host\path:/app").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some(r"D:\host\path"));
        assert_eq!(spec.guest_path, "/app");
    }

    #[test]
    fn test_parse_volume_spec_unix_three_colons_invalid() {
        // Unix path with 4+ segments and no Windows drive → error
        assert!(super::parse_volume_spec("/a:b:c:d").is_err());
    }

    #[test]
    fn test_parse_volume_spec_linux_unchanged() {
        // Linux/macOS style must still work
        let spec = super::parse_volume_spec("/data:/app/data").unwrap();
        assert_eq!(spec.host_path.as_deref(), Some("/data"));
        assert_eq!(spec.guest_path, "/app/data");
        let spec2 = super::parse_volume_spec("/data:/app/data:ro").unwrap();
        assert_eq!(spec2.host_path.as_deref(), Some("/data"));
        assert_eq!(spec2.guest_path, "/app/data");
        assert!(spec2.read_only);
    }

    #[test]
    fn test_volume_flags_apply_to() {
        let flags = VolumeFlags {
            volume: vec![
                "/host/data:/guest/data".to_string(),
                "/readonly:/ro:ro".to_string(),
            ],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, None).unwrap();
        assert_eq!(opts.volumes.len(), 2);
        assert_eq!(opts.volumes[0].host_path, "/host/data");
        assert_eq!(opts.volumes[0].guest_path, "/guest/data");
        assert!(!opts.volumes[0].read_only);
        assert_eq!(opts.volumes[1].host_path, "/readonly");
        assert_eq!(opts.volumes[1].guest_path, "/ro");
        assert!(opts.volumes[1].read_only);
    }

    #[test]
    fn test_volume_flags_apply_to_windows_style() {
        let flags = VolumeFlags {
            volume: vec![
                r"C:\host\data:/guest/data".to_string(),
                r"D:\readonly:/ro:ro".to_string(),
            ],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, None).unwrap();
        assert_eq!(opts.volumes.len(), 2);
        assert_eq!(opts.volumes[0].host_path, r"C:\host\data");
        assert_eq!(opts.volumes[0].guest_path, "/guest/data");
        assert!(!opts.volumes[0].read_only);
        assert_eq!(opts.volumes[1].host_path, r"D:\readonly");
        assert_eq!(opts.volumes[1].guest_path, "/ro");
        assert!(opts.volumes[1].read_only);
    }

    #[test]
    fn test_volume_flags_apply_to_anonymous() {
        let base = std::env::temp_dir();
        let flags = VolumeFlags {
            volume: vec!["/data".to_string(), "/cache:ro".to_string()],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, Some(&base)).unwrap();
        assert_eq!(opts.volumes.len(), 2);
        assert_eq!(opts.volumes[0].guest_path, "/data");
        assert!(
            opts.volumes[0].host_path.contains("anonymous"),
            "anonymous volume host_path should contain 'anonymous': {}",
            opts.volumes[0].host_path
        );
        assert!(std::path::Path::new(&opts.volumes[0].host_path).exists());
        assert_eq!(opts.volumes[1].guest_path, "/cache");
        assert!(opts.volumes[1].read_only);
        assert!(opts.volumes[1].host_path.contains("anonymous"));
    }

    // ─── auth subcommand parse tests ───────────────────────────────────────

    use crate::commands::auth::AuthCommand;
    use clap::Parser;

    #[test]
    fn auth_login_parses_with_no_flags() {
        let cli = Cli::try_parse_from(["boxlite", "auth", "login"]).expect("parse");
        let Commands::Auth(args) = cli.command else {
            panic!("expected Commands::Auth");
        };
        assert!(matches!(args.command, AuthCommand::Login(_)));
    }

    #[test]
    fn auth_logout_parses() {
        let cli = Cli::try_parse_from(["boxlite", "auth", "logout"]).expect("parse");
        let Commands::Auth(args) = cli.command else {
            panic!("expected Commands::Auth");
        };
        assert!(matches!(args.command, AuthCommand::Logout(_)));
    }

    #[test]
    fn auth_status_parses() {
        let cli = Cli::try_parse_from(["boxlite", "auth", "status"]).expect("parse");
        let Commands::Auth(args) = cli.command else {
            panic!("expected Commands::Auth");
        };
        assert!(matches!(args.command, AuthCommand::Status));
    }

    #[test]
    fn auth_login_api_key_stdin_parses() {
        // --api-key-stdin is the only non-interactive credential path
        // after the device-flow removal; it must parse cleanly.
        let cli = Cli::try_parse_from(["boxlite", "auth", "login", "--api-key-stdin"])
            .expect("--api-key-stdin should parse");
        let Commands::Auth(args) = cli.command else {
            panic!("expected Commands::Auth");
        };
        let AuthCommand::Login(login) = args.command else {
            panic!("expected AuthCommand::Login");
        };
        assert!(login.api_key_stdin);
    }
}
