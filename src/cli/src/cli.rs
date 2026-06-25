//! CLI definition and argument parsing for boxlite-cli.
//! This module contains all CLI-related code including the main CLI structure,
//! subcommands, and flag definitions.

use boxlite::runtime::options::{NetworkConfig, NetworkMode, PortProtocol, PortSpec, VolumeSpec};
use boxlite::{
    BoxCommand, BoxOptions, BoxliteOptions, BoxliteRestOptions, BoxliteRuntime, ImageRegistry,
    NetworkSpec,
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

    /// Named credential profile in `~/.boxlite/credentials.toml`. Lets one
    /// machine hold separate logins for, e.g., a local `boxlite serve` and a
    /// remote control plane. Defaults to `default` if neither flag nor env
    /// is set.
    #[arg(long, global = true, env = "BOXLITE_PROFILE")]
    pub profile: Option<String>,

    /// Routing-slot value for the URL path (`/v1/<prefix>/boxes/...`).
    /// Opaque — the server decides what this means (org id, workspace,
    /// catalog, …); the value typically comes from the `auth login`
    /// flow capturing `Principal.path_prefix`. This flag overrides
    /// the stored profile's path_prefix for users whose credential
    /// has scope over multiple routing values (e.g. multiple orgs on
    /// the same account). Unset → uses the stored profile's
    /// path_prefix, then empty (URL skips the segment —
    /// `/v1/boxes/...`).
    #[arg(long = "path-prefix", global = true, env = "BOXLITE_REST_PATH_PREFIX")]
    pub path_prefix: Option<String>,
}

impl GlobalFlags {
    /// Resolve which credential profile to read/write. Order: explicit
    /// `--profile` flag (which clap also fills from `BOXLITE_PROFILE`) > the
    /// hard-coded `default` name. Keeping this in one helper means a future
    /// "tab through last-used profile" UX has exactly one place to change.
    pub fn resolved_profile(&self) -> String {
        self.profile
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(crate::credentials::DEFAULT_PROFILE)
            .to_string()
    }

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
        let stored = crate::credentials::load_named(&self.resolved_profile())
            .ok()
            .flatten();
        // Clap reads BOXLITE_REST_URL into `self.url`; BOXLITE_API_KEY is the
        // one credential env we still consult directly here.
        let env_api_key = std::env::var("BOXLITE_API_KEY").ok();

        match self.resolve_rest_options(stored, env_api_key) {
            Some(opts) => BoxliteRuntime::rest(opts).map_err(Into::into),
            None => {
                // No URL anywhere → local runtime, unchanged behavior.
                let options = self.resolve_runtime_options()?;
                self.create_runtime_with_options(options)
            }
        }
    }

    /// Build REST connection options from the selected credential profile and
    /// the ambient `BOXLITE_API_KEY`. Returns `None` when no URL is configured
    /// (the caller then falls back to the local runtime). Pure — takes the
    /// resolved profile and env key as arguments and touches neither disk nor
    /// process environment — so the precedence below is unit-testable.
    ///
    /// Precedence (each axis independent):
    /// - URL: `--url` / `BOXLITE_REST_URL` > stored profile.
    /// - routing slot (`path_prefix`): `--path-prefix` /
    ///   `BOXLITE_REST_PATH_PREFIX` > stored profile.
    /// - bearer credential: `BOXLITE_API_KEY` > stored profile.
    ///
    /// `BOXLITE_API_KEY` overrides ONLY the bearer credential — the selected
    /// profile's url and path_prefix still apply, so `--profile p1` keeps
    /// routing to its tenant (`/v1/<prefix>/…`) even with an ambient key set.
    /// Building the options bare in that branch (instead of starting from the
    /// profile) was the cause of the prefix-less `/v1/boxes` 404 against a
    /// multi-tenant server.
    fn resolve_rest_options(
        &self,
        stored: Option<crate::credentials::Profile>,
        env_api_key: Option<String>,
    ) -> Option<BoxliteRestOptions> {
        let url = self
            .url
            .clone()
            .or_else(|| stored.as_ref().map(|p| p.url.clone()))?;

        // Start from the stored profile so its url + path_prefix (routing
        // slot) survive; the env key below overrides only the bearer.
        let mut opts = match stored {
            Some(profile) => {
                let mut from_profile = crate::credentials::into_rest_options(profile);
                // `--url` (resolved above) wins over the stored URL.
                from_profile.url = self.url.clone().unwrap_or(from_profile.url);
                from_profile
            }
            None => BoxliteRestOptions::new(url),
        };

        if let Some(key) = env_api_key.filter(|k| !k.is_empty()) {
            opts = opts.with_api_key(key);
        }

        // `--path-prefix` flag (or `BOXLITE_REST_PATH_PREFIX`, both filled by
        // clap into `self.path_prefix`) overrides the profile's routing slot.
        // Leaving it alone when the flag is unset means the profile's value
        // wins; if neither is set the URL builder skips the segment entirely
        // (`/v1/boxes/...`, the empty-prefix single-tenant shape).
        if let Some(path_prefix) = self.path_prefix.as_ref().filter(|s| !s.is_empty()) {
            opts.path_prefix = Some(path_prefix.clone());
        }

        Some(opts)
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

    /// Override the image entrypoint with a single executable, mirroring
    /// `docker run --entrypoint`. Sets the container's configured entrypoint;
    /// any trailing command is still exec'd as the foreground process.
    #[arg(long = "entrypoint", value_name = "EXEC")]
    pub entrypoint: Option<String>,
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
        if let Some(ref exec) = self.entrypoint {
            opts.entrypoint = Some(vec![exec.clone()]);
        }
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

    /// Container rootfs disk size (in GB). The COW overlay is sparse —
    /// actual on-disk usage grows as the workload writes. The virtual
    /// size is `max(this, base image size)`; smaller values are ignored.
    /// Default (unset) sizes the overlay to exactly the base image,
    /// leaving no headroom — set this for workloads that write
    /// significant data (in-box `docker pull`, `apt install`, `npm
    /// install`, build caches, etc.).
    #[arg(long = "disk-size", value_name = "GB")]
    pub disk_size_gb: Option<u64>,
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
        if let Some(gb) = self.disk_size_gb {
            opts.disk_size_gb = Some(gb);
        }
    }
}

// ============================================================================
// NETWORK FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct NetworkFlags {
    /// Network mode: "enabled" (default — full or allow-listed egress) or
    /// "disabled" (no interface at all; gvproxy is not started and the guest
    /// has no eth0).
    #[arg(long = "network", value_name = "MODE")]
    pub network: Option<String>,

    /// Restrict egress to the listed hosts/IPs (repeatable); everything else
    /// is DNS-sinkholed. Implies network=enabled. Patterns: exact host,
    /// "*.example.com", IP, or CIDR. Incompatible with `--network disabled`.
    #[arg(long = "allow-net", value_name = "HOST")]
    pub allow_net: Vec<String>,
}

impl NetworkFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        // Leave BoxOptions::default() (Enabled, full access) untouched when
        // neither flag is given, so a bare `run` behaves as before.
        if self.network.is_none() && self.allow_net.is_empty() {
            return Ok(());
        }
        let mode = match self.network.as_deref() {
            Some(value) => value.parse::<NetworkMode>()?,
            None => NetworkMode::Enabled,
        };
        opts.network = NetworkSpec::try_from(NetworkConfig {
            mode,
            allow_net: self.allow_net.clone(),
        })?;
        Ok(())
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

/// Result of parsing a volume spec. The source determines how the
/// runtime materialises the on-disk directory:
///
///   - `Anonymous`: fresh per-box ephemeral dir, ulid-named.
///   - `Named(s)`:  stable dir under `volumes/named/<s>`, shared
///     across boxes that mount the same name.
///
/// Host bind mounts (`-v /host:/guest`) are NOT a variant — the
/// parser rejects them so the CLI surfaces a migration message
/// instead of silently constructing a host_path the runtime would
/// later refuse.
#[derive(Debug)]
enum ParsedVolumeSource {
    Anonymous,
    Named(String),
}

#[derive(Debug)]
struct ParsedVolumeSpec {
    source: ParsedVolumeSource,
    guest_path: String,
    read_only: bool,
}

#[derive(Args, Debug, Clone)]
pub struct VolumeFlags {
    /// Mount a volume.
    ///
    /// Host bind mounts (`-v /host:/guest`) are not supported — they
    /// punch through box isolation. Use:
    ///
    ///   - `-v /data`               anonymous, ephemeral per-box
    ///   - `-v myvol:/data`         named, persists across boxes
    ///   - `-v myvol:/data:ro`      read-only named
    ///   - `-v /data:ro`            read-only anonymous
    ///
    /// For one-shot file transfer between host and box use `boxlite cp`.
    #[arg(short = 'v', long = "volume", value_name = "VOLUME")]
    pub volume: Vec<String>,
}

/// Parse options string (e.g. "ro" or "rw,nocopy") and return read_only. Other options are ignored.
fn parse_volume_read_only(opts: &str) -> bool {
    opts.split(',').any(|o| o.trim().eq_ignore_ascii_case("ro"))
}

/// Validate a named-volume identifier.
///
/// Names ride into a directory path on disk (`volumes/named/<name>`),
/// so they cannot contain path separators, the spec delimiter, or
/// `..`. Length is capped at 64 to keep `BOXLITE_HOME/volumes/named/<name>`
/// well under PATH_MAX on any sensible filesystem.
fn validate_volume_name(name: &str) -> anyhow::Result<()> {
    if name.is_empty() {
        anyhow::bail!("volume name must be non-empty");
    }
    if name.len() > 64 {
        anyhow::bail!(
            "volume name must be at most 64 characters; got {}",
            name.len()
        );
    }
    if name.contains('/') || name.contains(':') || name.contains('\\') {
        anyhow::bail!(
            "volume name must not contain '/', ':' or '\\\\'; got {:?}",
            name
        );
    }
    if name == "." || name == ".." || name.contains("..") {
        anyhow::bail!(
            "volume name must not be '.' or '..' or contain '..'; got {:?}",
            name
        );
    }
    Ok(())
}

/// Parse a single volume spec.
///
/// Accepted forms:
///   - `boxPath`                       anonymous, rw
///   - `boxPath:ro|rw`                 anonymous, with options
///   - `name:boxPath`                  named, rw
///   - `name:boxPath:ro|rw`            named, with options
///
/// Rejected (with a migration message):
///   - `hostPath:boxPath[:options]`    host bind mount — not supported.
///
/// The "is this a host bind mount?" check is the leading `/` on the
/// first segment: any `-v /<x>:<y>...` form is the legacy bind shape
/// (a bare `-v /data` stays anonymous because there's no second
/// segment to bind onto).
fn parse_volume_spec(s: &str) -> anyhow::Result<ParsedVolumeSpec> {
    let s = s.trim();
    if s.is_empty() {
        anyhow::bail!("empty volume spec");
    }
    let parts: Vec<&str> = s.split(':').map(str::trim).collect();

    // Reject host bind mounts up front, with a migration message that
    // points the user at the supported forms + `boxlite cp`.
    if parts.len() >= 2 && parts[0].starts_with('/') {
        let second = parts[1];
        let looks_like_options =
            second.eq_ignore_ascii_case("ro") || second.eq_ignore_ascii_case("rw");
        if !looks_like_options {
            anyhow::bail!(
                "host bind mounts (`-v /host:/guest`) are not supported. \
                 Use `-v <name>:{guest}` for a named volume (persists across boxes), \
                 `-v {guest}` for an anonymous volume (ephemeral), \
                 or `boxlite cp` for one-shot host file transfer.",
                guest = parts[1]
            );
        }
    }

    let (source, guest_path, read_only) = match parts.len() {
        1 => {
            // Anonymous volume: box path only.
            let guest = parts[0].to_string();
            if guest.is_empty() {
                anyhow::bail!("volume box path must be non-empty");
            }
            if !guest.starts_with('/') {
                anyhow::bail!(
                    "anonymous volume box path must be absolute (e.g. /data), got {:?}",
                    guest
                );
            }
            (ParsedVolumeSource::Anonymous, guest, false)
        }
        2 => {
            // Either anonymous-with-options (`guest:ro`) or named (`name:guest`).
            let second = parts[1];
            if second.eq_ignore_ascii_case("ro") || second.eq_ignore_ascii_case("rw") {
                let guest = parts[0].to_string();
                if guest.is_empty() {
                    anyhow::bail!("volume box path must be non-empty");
                }
                // Anonymous box paths must be absolute. Without this
                // check, a spec like `data:ro` would slip through —
                // `parts[0]` is "data" (relative), `parts[1]` is "ro"
                // (looks like options), so the 1-part absolute check
                // isn't reached. The contract is the same as the
                // 1-part case (`-v /data`) — only absolute guest paths
                // are accepted.
                if !guest.starts_with('/') {
                    anyhow::bail!(
                        "anonymous volume box path must be absolute (e.g. /data), got {:?}",
                        guest
                    );
                }
                (
                    ParsedVolumeSource::Anonymous,
                    guest,
                    second.eq_ignore_ascii_case("ro"),
                )
            } else {
                let name = parts[0].to_string();
                validate_volume_name(&name)?;
                let guest = parts[1].to_string();
                if !guest.starts_with('/') {
                    anyhow::bail!(
                        "named volume guest path must be absolute (e.g. /data), got {:?}",
                        guest
                    );
                }
                (ParsedVolumeSource::Named(name), guest, false)
            }
        }
        3 => {
            // Named with options: `name:guest:ro|rw|...`.
            let name = parts[0].to_string();
            validate_volume_name(&name)?;
            let guest = parts[1].to_string();
            if !guest.starts_with('/') {
                anyhow::bail!(
                    "named volume guest path must be absolute (e.g. /data), got {:?}",
                    guest
                );
            }
            let ro = parse_volume_read_only(parts[2]);
            (ParsedVolumeSource::Named(name), guest, ro)
        }
        _ => {
            anyhow::bail!(
                "invalid volume spec {:?}; supported forms: \
                 `<guest_path>`, `<guest_path>:ro`, `<name>:<guest_path>`, `<name>:<guest_path>:ro`",
                s
            );
        }
    };

    if guest_path.is_empty() {
        anyhow::bail!("volume box path must be non-empty");
    }
    Ok(ParsedVolumeSpec {
        source,
        guest_path,
        read_only,
    })
}

/// Resolve the base directory the CLI uses to materialise volume dirs:
/// explicit `--home`, then `$BOXLITE_HOME`, then `~/.boxlite`, then
/// temp dir as a last resort. The CLI creates volume dirs eagerly so
/// the runtime sees a path that already exists on disk; the runtime
/// then enforces that the path lives under `<runtime.home>/volumes/`
/// as a structural defence against SDK callers that bypass the CLI.
fn volume_home_base(home: Option<&std::path::Path>) -> std::path::PathBuf {
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

/// Materialise a volume directory under `base/volumes/...`, return the
/// absolute path. mkdir is idempotent for named (multiple boxes may
/// mount the same name); fresh-and-unique for anonymous.
fn materialize_volume(
    base: &std::path::Path,
    source: &ParsedVolumeSource,
) -> anyhow::Result<String> {
    let dir = match source {
        ParsedVolumeSource::Anonymous => {
            let unique = ulid::Ulid::new().to_string();
            base.join("volumes").join("anonymous").join(unique)
        }
        ParsedVolumeSource::Named(name) => base.join("volumes").join("named").join(name),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("failed to create volume dir {:?}: {}", dir, e))?;
    // 0700 keeps named volumes from leaking to other host users; the
    // box itself ID-maps in-guest so its uid=0 still has access.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        if let Err(e) = std::fs::set_permissions(&dir, perms) {
            tracing::warn!(path = %dir.display(), error = %e, "failed to chmod 0700 on volume dir");
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

impl VolumeFlags {
    /// Apply volume flags to options. Pass `home` for the volume root
    /// (typically `GlobalFlags.home`); the CLI materialises a real
    /// on-disk directory for each volume up-front so the runtime gate
    /// in `resolve_user_volumes` can verify the path lives under
    /// `<runtime.home>/volumes/`.
    pub fn apply_to(
        &self,
        opts: &mut BoxOptions,
        home: Option<&std::path::Path>,
    ) -> anyhow::Result<()> {
        let base = volume_home_base(home);
        for s in self.volume.iter() {
            let spec = parse_volume_spec(s)?;
            let host_path = materialize_volume(&base, &spec.source)?;
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

    /// Sandbox security: `enable` (default) or `disable` (case-insensitive).
    /// Absent → the box uses `SecurityOptions::default()` = enable, the
    /// fully-isolated profile. Use `--security=disable` to turn the sandbox
    /// off (master switch + all sub-protections) when debugging.
    #[arg(long, env = "BOXLITE_SECURITY")]
    pub security: Option<String>,
}

impl ManagementFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        opts.detach = self.detach;
        opts.auto_remove = self.rm;
        if let Some(ref preset) = self.security {
            // Bubble the typo'd-preset error all the way back to the
            // CLI exit so the operator sees the offending value.
            opts.advanced.security =
                boxlite::SecurityOptions::from_preset(preset).map_err(anyhow::Error::from)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

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
            profile: None,
            path_prefix: None,
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

    fn rest_flags(
        url: Option<&str>,
        profile: Option<&str>,
        path_prefix: Option<&str>,
    ) -> GlobalFlags {
        GlobalFlags {
            debug: false,
            home: None,
            registry: vec![],
            config: None,
            url: url.map(str::to_string),
            profile: profile.map(str::to_string),
            path_prefix: path_prefix.map(str::to_string),
        }
    }

    fn api_key_profile(path_prefix: Option<&str>) -> crate::credentials::Profile {
        crate::credentials::Profile {
            url: "https://api.example.com".to_string(),
            path_prefix: path_prefix.map(str::to_string),
            auth_method: crate::credentials::AuthMethod::ApiKey,
            api_key: Some(secrecy::SecretString::from("profile-bearer".to_string())),
            ..Default::default()
        }
    }

    #[test]
    fn api_key_env_preserves_profile_path_prefix() {
        // Regression: an ambient BOXLITE_API_KEY must override only the bearer,
        // not silently discard the selected profile's routing slot — dropping
        // it made the URL builder emit the prefix-less `/v1/boxes` shape, which
        // a multi-tenant server rejects with 404.
        let flags = rest_flags(None, Some("p1"), None);
        let opts = flags
            .resolve_rest_options(
                Some(api_key_profile(Some("acme"))),
                Some("env-key".to_string()),
            )
            .expect("REST options resolved");
        assert_eq!(
            opts.path_prefix.as_deref(),
            Some("acme"),
            "profile routing slot must survive an ambient BOXLITE_API_KEY"
        );
    }

    #[tokio::test]
    async fn api_key_env_overrides_profile_bearer_but_keeps_prefix() {
        // Confirmed precedence: env key wins for the bearer, profile prefix stays.
        let flags = rest_flags(None, Some("p1"), None);
        let opts = flags
            .resolve_rest_options(
                Some(api_key_profile(Some("acme"))),
                Some("env-key".to_string()),
            )
            .expect("REST options resolved");

        let token = opts
            .credential
            .expect("credential set")
            .get_token()
            .await
            .expect("token")
            .token;
        assert_eq!(
            token, "env-key",
            "BOXLITE_API_KEY overrides the profile bearer"
        );
        assert_eq!(
            opts.path_prefix.as_deref(),
            Some("acme"),
            "prefix preserved alongside the overridden bearer"
        );
    }

    #[test]
    fn api_key_env_without_profile_has_no_prefix() {
        // No profile → no routing slot, even with a key (single-tenant shape).
        let flags = rest_flags(Some("https://api.example.com"), None, None);
        let opts = flags
            .resolve_rest_options(None, Some("env-key".to_string()))
            .expect("REST options resolved");
        assert!(opts.path_prefix.is_none());
    }

    #[test]
    fn test_resource_flags_cpu_cap() {
        let flags = ResourceFlags {
            cpus: Some(1000),
            memory: None,
            disk_size_gb: None,
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        assert_eq!(opts.cpus, Some(255));
    }

    #[test]
    fn test_resource_flags_disk_size_plumbed() {
        // --disk-size <GB> must reach BoxOptions.disk_size_gb verbatim so the
        // COW overlay in container_rootfs::create_cow_disk picks up
        // max(user_size, base_image_size). A regression that drops this
        // flag would leave agent-workflow tests at base-image size and
        // they'd silently ENOSPC mid-`docker pull`.
        let flags = ResourceFlags {
            cpus: None,
            memory: None,
            disk_size_gb: Some(10),
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        assert_eq!(opts.disk_size_gb, Some(10));
    }

    #[test]
    fn test_resource_flags_disk_size_default_unset() {
        // No --disk-size on the command line means BoxOptions.disk_size_gb
        // stays None — container_rootfs::create_cow_disk's `if let Some`
        // branch is skipped and the COW disk is exactly the base image
        // size. This is the documented default; the test pins it so a
        // refactor that injects a fallback (`unwrap_or(N)`) would fail.
        let flags = ResourceFlags {
            cpus: None,
            memory: None,
            disk_size_gb: None,
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        assert_eq!(opts.disk_size_gb, None);
    }

    fn network_flags(network: Option<&str>, allow_net: &[&str]) -> NetworkFlags {
        NetworkFlags {
            network: network.map(str::to_string),
            allow_net: allow_net.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn test_network_flags_default_left_untouched() {
        // Neither flag set => BoxOptions::default() network is preserved
        // (Enabled, empty allow_net), so a bare `run` keeps full access.
        let mut opts = BoxOptions::default();
        network_flags(None, &[])
            .apply_to(&mut opts)
            .expect("no-op apply");

        assert!(
            matches!(opts.network, NetworkSpec::Enabled { ref allow_net } if allow_net.is_empty())
        );
    }

    #[test]
    fn test_network_flags_disabled() {
        // --network disabled => NetworkSpec::Disabled (no eth0, gvproxy off).
        let mut opts = BoxOptions::default();
        network_flags(Some("disabled"), &[])
            .apply_to(&mut opts)
            .expect("disabled is valid");

        assert!(matches!(opts.network, NetworkSpec::Disabled));
    }

    #[test]
    fn test_network_flags_allow_net_implies_enabled() {
        // --allow-net without --network => Enabled with the egress allowlist,
        // matching the REST NetworkConfig{mode, allow_net} mapping.
        let mut opts = BoxOptions::default();
        network_flags(None, &["api.openai.com", "10.0.0.0/8"])
            .apply_to(&mut opts)
            .expect("allow-net implies enabled");

        match opts.network {
            NetworkSpec::Enabled { allow_net } => {
                assert_eq!(allow_net, vec!["api.openai.com", "10.0.0.0/8"]);
            }
            other => panic!("expected Enabled with allowlist, got {other:?}"),
        }
    }

    #[test]
    fn test_network_flags_disabled_with_allow_net_is_rejected() {
        // --network disabled + --allow-net is contradictory; the error comes
        // from NetworkSpec::try_from (single source of truth), not the CLI.
        let mut opts = BoxOptions::default();
        let err = network_flags(Some("disabled"), &["api.openai.com"])
            .apply_to(&mut opts)
            .expect_err("disabled + allow-net must error");

        assert!(err.to_string().contains("allow_net"));
    }

    #[test]
    fn test_network_flags_invalid_mode_is_rejected() {
        // Unknown mode strings surface NetworkMode::from_str's error rather
        // than silently defaulting to enabled.
        let mut opts = BoxOptions::default();
        let err = network_flags(Some("bridge"), &[])
            .apply_to(&mut opts)
            .expect_err("unknown mode must error");

        assert!(err.to_string().contains("network.mode"));
    }

    fn process_flags_with_entrypoint(entrypoint: Option<&str>) -> ProcessFlags {
        ProcessFlags {
            interactive: false,
            tty: false,
            env: Vec::new(),
            workdir: None,
            user: None,
            entrypoint: entrypoint.map(str::to_string),
        }
    }

    #[test]
    fn test_process_flags_entrypoint_override() {
        // --entrypoint <EXEC> reaches BoxOptions.entrypoint as a single-token
        // argv, which container_rootfs applies as config.entrypoint.
        let mut opts = BoxOptions::default();
        process_flags_with_entrypoint(Some("/bin/bash"))
            .apply_to(&mut opts)
            .expect("entrypoint apply");

        assert_eq!(opts.entrypoint, Some(vec!["/bin/bash".to_string()]));
    }

    #[test]
    fn test_process_flags_entrypoint_default_none() {
        // No --entrypoint leaves BoxOptions.entrypoint None so the image's
        // own entrypoint is used unchanged.
        let mut opts = BoxOptions::default();
        process_flags_with_entrypoint(None)
            .apply_to(&mut opts)
            .expect("no-op apply");

        assert_eq!(opts.entrypoint, None);
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

    // ============================================================
    // Volume parser — step 2: host bind mounts rejected; only
    // anonymous (`/guest`) and named (`name:/guest`) shapes accepted.
    // ============================================================

    /// Side B (bind mount accepted) — `-v /host:/guest` MUST surface a
    /// migration message and exit non-zero. Reverting the
    /// "parts[0].starts_with('/') && parts.len() >= 2" reject in
    /// `parse_volume_spec` flips this red.
    #[test]
    fn parse_volume_spec_rejects_host_bind_mount() {
        let err = super::parse_volume_spec("/host/data:/guest/data")
            .expect_err("host bind mount must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("host bind mounts (`-v /host:/guest`) are not supported"),
            "expected migration message; got {msg}"
        );
        assert!(
            msg.contains("named volume") || msg.contains("anonymous"),
            "error must point at the supported forms; got {msg}"
        );
    }

    #[test]
    fn parse_volume_spec_rejects_host_bind_mount_with_ro_three_parts() {
        // `/host:/guest:ro` — host path + guest + ro is also the legacy
        // shape. The first-segment-starts-with-`/`-and-second-segment-
        // doesn't-look-like-options check below handles it cleanly:
        // parts[1] = `/guest`, which is not "ro"/"rw", so we fall into
        // the reject branch.
        let err =
            super::parse_volume_spec("/host:/guest:ro").expect_err("must reject /host:/guest:ro");
        assert!(err.to_string().contains("host bind mounts"), "got {err}");
    }

    #[test]
    fn parse_volume_spec_anonymous() {
        let spec = super::parse_volume_spec("/data").unwrap();
        assert!(matches!(spec.source, super::ParsedVolumeSource::Anonymous));
        assert_eq!(spec.guest_path, "/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn parse_volume_spec_anonymous_ro() {
        let spec = super::parse_volume_spec("/data:ro").unwrap();
        assert!(matches!(spec.source, super::ParsedVolumeSource::Anonymous));
        assert_eq!(spec.guest_path, "/data");
        assert!(spec.read_only);
    }

    #[test]
    fn parse_volume_spec_anonymous_relative_invalid() {
        assert!(super::parse_volume_spec("data").is_err());
    }

    /// Coderabbitai #639 finding: the 2-part `<word>:<word>` shape
    /// where the second is `ro`/`rw` is anonymous-with-options. The
    /// 1-part case already requires an absolute guest path, but the
    /// 2-part case used to let `data:ro` slip through. Reverting the
    /// `if !guest.starts_with('/') { bail }` block flips this red.
    #[test]
    fn parse_volume_spec_anonymous_relative_with_options_invalid() {
        let err = super::parse_volume_spec("data:ro").expect_err("relative + ro must reject");
        assert!(
            err.to_string().contains("must be absolute"),
            "rejection must point at the absolute-path contract; got {err}"
        );
        // Same for `rw` — confirms it's not just `ro`-specific.
        let err = super::parse_volume_spec("data:rw").expect_err("relative + rw must reject");
        assert!(err.to_string().contains("must be absolute"));
    }

    #[test]
    fn parse_volume_spec_named() {
        let spec = super::parse_volume_spec("myvol:/data").unwrap();
        match spec.source {
            super::ParsedVolumeSource::Named(name) => assert_eq!(name, "myvol"),
            other => panic!("expected Named, got {:?}", std::mem::discriminant(&other)),
        }
        assert_eq!(spec.guest_path, "/data");
        assert!(!spec.read_only);
    }

    #[test]
    fn parse_volume_spec_named_ro() {
        let spec = super::parse_volume_spec("myvol:/data:ro").unwrap();
        match spec.source {
            super::ParsedVolumeSource::Named(name) => assert_eq!(name, "myvol"),
            other => panic!("expected Named, got {:?}", std::mem::discriminant(&other)),
        }
        assert_eq!(spec.guest_path, "/data");
        assert!(spec.read_only);
    }

    #[test]
    fn parse_volume_spec_named_guest_must_be_absolute() {
        let err = super::parse_volume_spec("myvol:data").expect_err("relative guest must reject");
        assert!(err.to_string().contains("absolute"), "got {err}");
    }

    #[test]
    fn parse_volume_spec_invalid_volume_name() {
        // `..`, `/`, `:`, `\` are all rejected by validate_volume_name.
        for bad in ["..", "a/b", "a..b", "", "x".repeat(65).as_str()] {
            let spec = format!("{bad}:/data");
            let result = super::parse_volume_spec(&spec);
            // `:` in the input becomes a separator so empty-name and
            // 65-char hit different code paths than `/` and `..`; either
            // way we just want a non-Ok return.
            assert!(result.is_err(), "expected reject for {spec:?}");
        }
    }

    #[test]
    fn parse_volume_spec_invalid_empty_parts() {
        assert!(super::parse_volume_spec(":/app").is_err());
        assert!(super::parse_volume_spec("/data:").is_err());
    }

    #[test]
    fn volume_flags_apply_to_anonymous_materializes_under_home_volumes() {
        let tmp = tempfile::tempdir().unwrap();
        let flags = VolumeFlags {
            volume: vec!["/data".to_string(), "/cache:ro".to_string()],
        };
        let mut opts = BoxOptions::default();
        flags
            .apply_to(&mut opts, Some(tmp.path()))
            .expect("anonymous flags should apply");
        assert_eq!(opts.volumes.len(), 2);
        for (i, vol) in opts.volumes.iter().enumerate() {
            assert!(
                vol.host_path.starts_with(tmp.path().to_str().unwrap()),
                "host_path must be under home; got {} (vol {i})",
                vol.host_path
            );
            assert!(
                vol.host_path.contains("/volumes/anonymous/"),
                "anonymous vol host_path must live under volumes/anonymous/; got {} (vol {i})",
                vol.host_path
            );
            assert!(
                std::path::Path::new(&vol.host_path).is_dir(),
                "host_path must exist as a dir; got {} (vol {i})",
                vol.host_path
            );
        }
        assert_eq!(opts.volumes[0].guest_path, "/data");
        assert!(!opts.volumes[0].read_only);
        assert_eq!(opts.volumes[1].guest_path, "/cache");
        assert!(opts.volumes[1].read_only);
    }

    #[test]
    fn volume_flags_apply_to_named_is_stable_across_invocations() {
        // Same `name` → same dir. The named volume is reused, which is
        // the property the persistence story depends on.
        let tmp = tempfile::tempdir().unwrap();
        let flags = VolumeFlags {
            volume: vec!["myvol:/data".to_string()],
        };
        let mut opts_a = BoxOptions::default();
        flags.apply_to(&mut opts_a, Some(tmp.path())).unwrap();
        let mut opts_b = BoxOptions::default();
        flags.apply_to(&mut opts_b, Some(tmp.path())).unwrap();
        assert_eq!(
            opts_a.volumes[0].host_path, opts_b.volumes[0].host_path,
            "named volume host_path must be stable across applications"
        );
        let expected = tmp.path().join("volumes").join("named").join("myvol");
        assert_eq!(
            opts_a.volumes[0].host_path,
            expected.to_string_lossy(),
            "named volume must materialize under volumes/named/<name>"
        );
        assert!(expected.is_dir());
    }

    #[test]
    fn volume_flags_apply_to_rejects_host_bind() {
        // Side B: removing the parser reject branch makes this test go
        // green for the wrong reason (legacy /host:/guest would resolve).
        let flags = VolumeFlags {
            volume: vec!["/host/data:/guest/data".to_string()],
        };
        let mut opts = BoxOptions::default();
        let err = flags
            .apply_to(&mut opts, Some(std::env::temp_dir().as_path()))
            .expect_err("legacy host bind must be rejected by apply_to");
        assert!(err.to_string().contains("host bind mounts"));
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

    // ============================================================
    // ManagementFlags --security
    //
    // Side A (setting valid) — `--security=disable` lands as
    // SecurityOptions::disabled() on the resulting BoxOptions.
    // Side B (setting invalid) — surfaces back as an
    // anyhow::Error pointing at the offending value. Reverting the
    // `from_preset(preset)?` call in apply_to flips both red.
    // ============================================================

    #[test]
    fn management_security_preset_applies_to_box_options() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            security: Some("disable".to_string()),
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts).expect("setting must apply");
        assert_eq!(
            opts.advanced.security,
            boxlite::SecurityOptions::disabled(),
            "advanced.security must equal SecurityOptions::disabled()"
        );
    }

    #[test]
    fn management_security_preset_absent_leaves_default() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            security: None,
        };
        let mut opts = BoxOptions::default();
        flags
            .apply_to(&mut opts)
            .expect("absent preset must succeed");
        assert_eq!(
            opts.advanced.security,
            boxlite::SecurityOptions::default(),
            "absent preset must leave the default in place"
        );
    }

    #[test]
    fn management_security_preset_typo_surfaces_anyhow_error() {
        let flags = ManagementFlags {
            name: None,
            detach: false,
            rm: false,
            security: Some("ultra".to_string()),
        };
        let mut opts = BoxOptions::default();
        let err = flags
            .apply_to(&mut opts)
            .expect_err("unknown preset must reject at apply_to");
        let msg = err.to_string();
        assert!(msg.contains("ultra"), "got {msg}");
    }
}
