//! CLI definition and argument parsing for boxlite-cli.
//! This module contains all CLI-related code including the main CLI structure,
//! subcommands, and flag definitions.

use boxlite::experimental::custom_kernel::{KernelFormat, KernelOptions, configure};
use boxlite::experimental::{
    EXPERIMENTAL_FEATURES_ENV, ExperimentalFeature, ExperimentalFeatures, RuntimeBuilder,
};
use boxlite::runtime::options::{
    InboundNetworkConfig, NetworkMode, OutboundNetworkConfig, PortProtocol, PortSpec, VolumeSpec,
};
use boxlite::{
    BoxCommand, BoxOptions, BoxliteOptions, BoxliteRestOptions, BoxliteRuntime,
    ContainerCapabilities, ImageRegistry, NetworkSpec, Secret,
};
use clap::{Args, Command, Parser, Subcommand, ValueEnum};
use clap_complete::shells::{Bash, Fish, Zsh};
use std::collections::HashMap;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

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
    /// Run a command in a new box
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

    /// Manage box networking
    Network(crate::commands::network::NetworkArgs),

    /// Start a long-running REST API server
    Serve(crate::commands::serve::ServeArgs),

    /// Authenticate with a remote BoxLite server
    Auth(crate::commands::auth::AuthArgs),

    /// Manage named local volumes
    Volume(crate::commands::volume::VolumeArgs),

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
    // clap_complete's AOT generators enumerate hidden arguments. Generate
    // from a projection of the affected commands so RC flags remain
    // parseable without becoming a discovery surface.
    let mut cmd = completion_projection(cmd);
    match shell {
        Shell::Bash => clap_complete::generate(Bash, &mut cmd, name, out),
        Shell::Zsh => clap_complete::generate(Zsh, &mut cmd, name, out),
        Shell::Fish => clap_complete::generate(Fish, &mut cmd, name, out),
    }
}

fn completion_projection(cmd: &Command) -> Command {
    cmd.clone()
        .mut_subcommand("run", without_hidden_arguments)
        .mut_subcommand("create", without_hidden_arguments)
}

fn without_hidden_arguments(command: Command) -> Command {
    let name = match command.get_name() {
        "run" => "run",
        "create" => "create",
        other => panic!("completion projection is not defined for {other}"),
    };
    let about = command.get_about().cloned();
    let long_about = command.get_long_about().cloned();
    let display_order = command.get_display_order();
    let visible_arguments = command
        .get_arguments()
        .filter(|argument| !argument.is_hide_set())
        .cloned()
        .collect::<Vec<_>>();
    let subcommands = command.get_subcommands().cloned().collect::<Vec<_>>();

    let mut projected = Command::new(name)
        .display_order(display_order)
        .args(visible_arguments)
        .subcommands(subcommands);
    if let Some(about) = about {
        projected = projected.about(about);
    }
    if let Some(long_about) = long_about {
        projected = projected.long_about(long_about);
    }
    projected
}

pub(crate) fn experimental_features_from_env() -> boxlite::BoxliteResult<ExperimentalFeatures> {
    match std::env::var(EXPERIMENTAL_FEATURES_ENV) {
        Ok(value) => ExperimentalFeatures::parse(&value),
        Err(std::env::VarError::NotPresent) => Ok(ExperimentalFeatures::default()),
        Err(std::env::VarError::NotUnicode(_)) => Err(boxlite::BoxliteError::Config(format!(
            "{EXPERIMENTAL_FEATURES_ENV} must contain valid UTF-8"
        ))),
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

    #[arg(skip)]
    pub(crate) experimental_features: ExperimentalFeatures,
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

    pub fn experimental_features(&self) -> &ExperimentalFeatures {
        &self.experimental_features
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
        RuntimeBuilder::new(options)
            .with_features(self.experimental_features.clone())
            .build()
            .map_err(Into::into)
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
    /// `docker run --entrypoint`. Any trailing COMMAND replaces the image's
    /// CMD and is appended to it, and the result runs as the container's
    /// init.
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
        if let Some(ref user) = self.user {
            opts.user = Some(user.clone());
        }
        // `-t` is a property of the container's init, which COMMAND now is, so
        // it has to be decided here at create time rather than at attach.
        opts.tty = self.tty;
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
// CAPABILITY FLAGS
// ============================================================================

#[derive(Args, Debug, Clone, Default)]
pub struct CapabilityFlags {
    /// Add a Linux capability to the container (repeatable; `ALL` is supported)
    #[arg(long = "cap-add", value_name = "CAPABILITY")]
    pub cap_add: Vec<String>,

    /// Drop a Linux capability from the container (repeatable; `ALL` is supported)
    #[arg(long = "cap-drop", value_name = "CAPABILITY")]
    pub cap_drop: Vec<String>,
}

impl CapabilityFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        if self.cap_add.is_empty() && self.cap_drop.is_empty() {
            return;
        }
        opts.advanced
            .set_capabilities(Some(ContainerCapabilities {
                add: self.cap_add.clone(),
                drop: self.cap_drop.clone(),
            }))
            .expect("apply_to runs before options are resolved");
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
// KERNEL FLAGS
// ============================================================================

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum KernelFormatArg {
    Auto,
    Raw,
    Elf,
    PeGz,
    ImageBz2,
    ImageGz,
    ImageZstd,
}

impl From<KernelFormatArg> for KernelFormat {
    fn from(format: KernelFormatArg) -> Self {
        match format {
            KernelFormatArg::Auto => Self::Auto,
            KernelFormatArg::Raw => Self::Raw,
            KernelFormatArg::Elf => Self::Elf,
            KernelFormatArg::PeGz => Self::PeGz,
            KernelFormatArg::ImageBz2 => Self::ImageBz2,
            KernelFormatArg::ImageGz => Self::ImageGz,
            KernelFormatArg::ImageZstd => Self::ImageZstd,
        }
    }
}

// Direct Linux boot options. Companion flags are valid only with `--kernel`.
#[derive(Args, Debug, Clone, Default)]
pub struct KernelFlags {
    /// Boot with this Linux kernel image instead of BoxLite's bundled kernel.
    #[arg(long, value_name = "PATH", hide = true)]
    pub kernel: Option<PathBuf>,

    /// Kernel image format. Auto-detected by default.
    #[arg(
        long,
        value_enum,
        value_name = "FORMAT",
        requires = "kernel",
        hide = true
    )]
    pub kernel_format: Option<KernelFormatArg>,

    /// Initial ramdisk to load with the custom kernel.
    #[arg(long, value_name = "PATH", requires = "kernel", hide = true)]
    pub initramfs: Option<PathBuf>,

    /// Replace libkrun's default Linux kernel command line.
    #[arg(
        long = "kernel-args",
        value_name = "ARGS",
        requires = "kernel",
        hide = true
    )]
    pub kernel_args: Option<String>,
}

impl KernelFlags {
    pub fn require_enabled(&self, features: &ExperimentalFeatures) -> boxlite::BoxliteResult<()> {
        if self.kernel.is_none() {
            return Ok(());
        }

        features.require(ExperimentalFeature::CustomKernel)
    }

    pub fn apply_to(&self, opts: &mut BoxOptions) {
        let Some(path) = &self.kernel else {
            return;
        };
        configure(
            opts,
            KernelOptions {
                path: path.clone(),
                format: self.kernel_format.map(Into::into).unwrap_or_default(),
                initramfs: self.initramfs.clone(),
                command_line: self.kernel_args.clone(),
            },
        );
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

    /// Restrict TCP and UDP egress to the listed hosts/IPs (repeatable);
    /// everything else is DNS-sinkholed and dropped. Implies network=enabled.
    /// Patterns: exact host, "*.example.com", IP, or CIDR. Hostname rules need
    /// TLS SNI / HTTP Host inspection, so a hostname-only list denies all UDP;
    /// add the IP or CIDR to keep UDP open. Incompatible with `--network
    /// disabled`.
    #[arg(long = "allow-net", value_name = "HOST")]
    pub allow_net: Vec<String>,

    /// Inbound mode: "enabled" (default — services the box exposes are
    /// publicly reachable) or "disabled" (private, unreachable from outside
    /// the box).
    #[arg(long = "inbound", value_name = "MODE")]
    pub inbound: Option<String>,
}

impl NetworkFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        // Leave BoxOptions::default() (outbound Enabled/full access, inbound
        // Enabled/public) untouched when no flag is given, so a bare `run`
        // behaves as before.
        if self.network.is_none() && self.allow_net.is_empty() && self.inbound.is_none() {
            return Ok(());
        }
        let mode = match self.network.as_deref() {
            Some(value) => value.parse::<NetworkMode>()?,
            None => NetworkMode::Enabled,
        };
        let inbound_mode = match self.inbound.as_deref() {
            Some(value) => value.parse::<NetworkMode>()?,
            None => NetworkMode::Enabled,
        };
        opts.network = NetworkSpec::try_from(OutboundNetworkConfig {
            mode,
            allow_net: self.allow_net.clone(),
        })?;
        opts.inbound_network = NetworkSpec::try_from(InboundNetworkConfig {
            mode: inbound_mode,
            allow_net: Vec::new(),
        })?;
        Ok(())
    }
}

// ============================================================================
// SECRET FLAGS (MITM substitution)
// ============================================================================

/// Secrets for outbound HTTP(S) MITM substitution. The real value never
/// enters the guest VM: the guest sees only the `<BOXLITE_SECRET:{name}>`
/// placeholder (injected as `BOXLITE_SECRET_<NAME>`), and gvproxy swaps it
/// for the real value at the network boundary.
#[derive(Args, Debug, Clone, Default)]
pub struct SecretFlags {
    /// Secret for MITM substitution: NAME=VALUE (repeatable). Injects the
    /// env var BOXLITE_SECRET_<NAME> into the guest holding the placeholder
    /// <BOXLITE_SECRET:<NAME>>; the network proxy swaps that placeholder for
    /// VALUE on the hosts given by --secret-host, so the real value never
    /// enters the VM. The value is visible on argv — scripts and CI should
    /// use `--secret-from-env` instead.
    #[arg(long = "secret", value_name = "NAME=VALUE")]
    pub secrets: Vec<String>,

    /// Same as --secret (same guest env var BOXLITE_SECRET_<NAME> and
    /// placeholder <BOXLITE_SECRET:<NAME>>), but the value is read from the
    /// host environment variable ENV_VAR, so it never appears on argv, shell
    /// history, or CI command logs. Repeatable.
    #[arg(long = "secret-from-env", value_name = "NAME=ENV_VAR")]
    pub secret_env: Vec<String>,

    /// Host where a secret applies: NAME=HOST (repeatable). Patterns: exact
    /// host or "*.example.com" (matches one subdomain level). A secret with no
    /// host rule is rejected.
    #[arg(long = "secret-host", value_name = "NAME=HOST")]
    pub hosts: Vec<String>,
}

impl SecretFlags {
    /// Apply secret flags to `opts.secrets`.
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        self.apply_to_with_lookup(opts, |k| std::env::var(k).ok())
    }

    /// Dependency-injected env lookup for tests (mirrors [`ProcessFlags`]).
    fn apply_to_with_lookup<F>(&self, opts: &mut BoxOptions, lookup: F) -> anyhow::Result<()>
    where
        F: Fn(&str) -> Option<String>,
    {
        if self.secrets.is_empty() && self.secret_env.is_empty() && self.hosts.is_empty() {
            return Ok(());
        }

        // Pair --secret-host NAME=HOST rules to secrets by name.
        let mut hosts_by_name: HashMap<&str, Vec<String>> = HashMap::new();
        for rule in &self.hosts {
            let (name, host) = parse_name_value(rule, "--secret-host")?;
            hosts_by_name
                .entry(name)
                .or_default()
                .push(host.to_string());
        }

        // Collect (name, value) from both sources. Duplicate names are rejected.
        let mut value_by_name: Vec<(&str, String)> = Vec::new();
        for rule in &self.secrets {
            let (name, value) = parse_name_value(rule, "--secret")?;
            push_unique_secret(&mut value_by_name, name, value.to_string())?;
        }
        for rule in &self.secret_env {
            let (name, env_var) = parse_name_value(rule, "--secret-from-env")?;
            let value = lookup(env_var).ok_or_else(|| {
                anyhow::anyhow!(
                    "--secret-from-env {name}: environment variable {env_var:?} is not set"
                )
            })?;
            push_unique_secret(&mut value_by_name, name, value)?;
        }

        for (name, value) in value_by_name {
            let hosts = hosts_by_name.remove(name).unwrap_or_default();
            if hosts.is_empty() {
                anyhow::bail!(
                    "--secret {name} has no --secret-host rule; add --secret-host {name}=HOST \
                     so the MITM proxy knows which host to intercept"
                );
            }
            opts.secrets.push(Secret {
                name: name.to_string(),
                value,
                hosts,
                placeholder: format!("<BOXLITE_SECRET:{name}>"),
            });
        }

        if let Some(name) = hosts_by_name.keys().next() {
            anyhow::bail!(
                "--secret-host {name} has no matching --secret or --secret-from-env entry"
            );
        }

        Ok(())
    }
}

/// Parse a NAME=VALUE flag argument, rejecting malformed or empty parts.
fn parse_name_value<'a>(arg: &'a str, flag: &str) -> anyhow::Result<(&'a str, &'a str)> {
    let Some((name, value)) = arg.split_once('=') else {
        anyhow::bail!("{flag} expects NAME=VALUE, got {arg:?}");
    };
    if name.is_empty() {
        anyhow::bail!("{flag}: NAME must not be empty");
    }
    if value.is_empty() {
        anyhow::bail!("{flag} {name}: VALUE must not be empty");
    }
    Ok((name, value))
}

/// Append `(name, value)` to `entries`, or error when the name is a duplicate.
fn push_unique_secret<'a>(
    entries: &mut Vec<(&'a str, String)>,
    name: &'a str,
    value: String,
) -> anyhow::Result<()> {
    if entries.iter().any(|(n, _)| *n == name) {
        anyhow::bail!("duplicate secret name {name:?}; each secret needs a unique name");
    }
    entries.push((name, value));
    Ok(())
}

// ============================================================================
// PUBLISH (PORT) FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct PublishFlags {
    /// Publish a TCP box port locally (boxPort uses an automatic host port)
    #[arg(short = 'p', long = "publish", value_name = "PORT")]
    pub publish: Vec<String>,
}

impl PublishFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        for s in &self.publish {
            let spec = parse_publish_spec(s)?;
            opts.ports.push(spec);
        }
        Ok(())
    }
}

/// Parse a single publish spec: `[hostPort:]boxPort[/tcp]`.
/// - `boxPort` → host_port=None, guest_port=boxPort
/// - `hostPort:boxPort` → host_port=Some(hostPort), guest_port=boxPort
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
                anyhow::bail!("UDP port forwarding is not implemented; use TCP")
            } else {
                anyhow::bail!("invalid protocol {:?}; use tcp", proto)
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

#[derive(Args, Debug, Clone)]
pub struct VolumeFlags {
    /// Mount a volume: VOLUME:BOX_PATH for a managed volume, HOST_PATH:BOX_PATH[:options]
    /// for a host bind (host paths start with `/`, `./`, `~` or a drive letter), or
    /// BOX_PATH[:options] for an anonymous volume
    #[arg(short = 'v', long = "volume", value_name = "VOLUME")]
    pub volume: Vec<String>,
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

/// Make a host bind path absolute.
///
/// `volumespec` classified this as a path without touching the filesystem, so a
/// relative one is resolved here — the same split Docker uses, where the client
/// absolutizes and only the resolved path travels on.
fn resolve_host_path(path: String) -> anyhow::Result<String> {
    // A Windows path is absolute even where `Path::is_relative` says otherwise:
    // on Unix `C:\data` has no leading `/`, so without this it would be
    // canonicalized against the working directory and fail.
    if !std::path::Path::new(&path).is_relative()
        || crate::volumespec::is_windows_drive_prefix(&path)
    {
        return Ok(path);
    }

    let absolute = std::fs::canonicalize(&path)
        .map_err(|e| anyhow::anyhow!("volume host path {:?}: {}", path, e))?;
    Ok(absolute.to_string_lossy().into_owned())
}

impl VolumeFlags {
    /// Apply volume flags to options. Pass `home` for anonymous volume storage (e.g. from GlobalFlags).
    pub fn apply_to(
        &self,
        opts: &mut BoxOptions,
        home: Option<&std::path::Path>,
    ) -> anyhow::Result<()> {
        let base = anonymous_volume_base(home);
        for value in self.volume.iter() {
            let mount = crate::volumespec::parse(value)?;

            let spec = match mount.origin {
                // Held as written; the server resolves an id or a name.
                crate::volumespec::MountOrigin::ManagedVolume(volume) => {
                    // Neither the server nor the REST client accepts one yet;
                    // saying so here beats a downgrade the caller never sees.
                    if mount.read_only {
                        anyhow::bail!(
                            "read-only managed volumes are not supported yet; \
                             mount {volume:?} read-write"
                        );
                    }
                    VolumeSpec::managed_volume(volume, mount.guest_path)
                }

                crate::volumespec::MountOrigin::BindMount(path) => {
                    VolumeSpec::bind_mount(resolve_host_path(path)?, mount.guest_path)
                }

                crate::volumespec::MountOrigin::Anonymous => {
                    // Random id for the directory name (same approach as Podman:
                    // cryptographically random to avoid collisions under any load).
                    let unique = ulid::Ulid::new().to_string();
                    let dir = base.join("volumes").join("anonymous").join(unique);
                    std::fs::create_dir_all(&dir).map_err(|e| {
                        anyhow::anyhow!("failed to create anonymous volume dir {:?}: {}", dir, e)
                    })?;
                    VolumeSpec::bind_mount(dir.to_string_lossy().into_owned(), mount.guest_path)
                }
            };

            opts.volumes.push(VolumeSpec {
                read_only: mount.read_only,
                ..spec
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

    /// Require nested virtualization for workloads in the box.
    /// Starting the box fails if the host cannot provide it.
    #[arg(long = "nested-virtualization", hide = true)]
    pub nested_virtualization: bool,
}

impl ManagementFlags {
    pub fn require_enabled(&self, features: &ExperimentalFeatures) -> boxlite::BoxliteResult<()> {
        if !self.nested_virtualization {
            return Ok(());
        }

        features.require(ExperimentalFeature::NestedVirtualization)
    }

    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        opts.detach = self.detach;
        // `--rm` is the CLI spelling of "delete when stopped"; the CLI
        // default (like `docker run`) is to keep the box.
        opts.auto_delete = Some(if self.rm { 1 } else { 0 });
        if let Some(ref preset) = self.security {
            // Bubble the typo'd-preset error all the way back to the
            // CLI exit so the operator sees the offending value.
            opts.advanced.security =
                boxlite::SecurityOptions::from_preset(preset).map_err(anyhow::Error::from)?;
        }
        if self.nested_virtualization {
            opts.advanced.nested_virtualization = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::runtime::options::NetworkSpec;
    use clap::CommandFactory;
    use std::fs;
    use std::path::PathBuf;
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
            experimental_features: ExperimentalFeatures::default(),
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
            experimental_features: ExperimentalFeatures::default(),
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

    #[test]
    fn custom_kernel_flags_are_applied_as_one_boot_configuration() {
        let flags = KernelFlags {
            kernel: Some(PathBuf::from("/tmp/vmlinux")),
            kernel_format: Some(KernelFormatArg::Elf),
            initramfs: Some(PathBuf::from("/tmp/initramfs.img")),
            kernel_args: Some("console=ttyS0 panic=-1".to_string()),
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        let kernel = opts.advanced.kernel.expect("custom kernel configuration");
        assert_eq!(kernel.path, PathBuf::from("/tmp/vmlinux"));
        assert_eq!(kernel.format, KernelFormat::Elf);
        assert_eq!(kernel.initramfs, Some(PathBuf::from("/tmp/initramfs.img")));
        assert_eq!(
            kernel.command_line.as_deref(),
            Some("console=ttyS0 panic=-1")
        );
    }

    #[test]
    fn custom_kernel_gate_uses_explicit_feature_state() {
        let flags = KernelFlags {
            kernel: Some(PathBuf::from("/tmp/vmlinux")),
            ..Default::default()
        };

        let error = flags
            .require_enabled(&ExperimentalFeatures::default())
            .expect_err("custom kernel must be disabled by default");
        assert!(
            error
                .to_string()
                .contains("ExperimentalFeature::CustomKernel")
        );

        let enabled = ExperimentalFeatures::parse("custom-kernel").unwrap();
        flags.require_enabled(&enabled).unwrap();
    }

    #[test]
    fn nested_virtualization_gate_uses_explicit_feature_state() {
        let flags = ManagementFlags {
            nested_virtualization: true,
            name: None,
            detach: false,
            rm: false,
            security: None,
        };

        let error = flags
            .require_enabled(&ExperimentalFeatures::default())
            .expect_err("nested virtualization must be disabled by default");
        assert!(
            error
                .to_string()
                .contains("ExperimentalFeature::NestedVirtualization")
        );

        let enabled = ExperimentalFeatures::parse("nested-virtualization").unwrap();
        flags.require_enabled(&enabled).unwrap();
    }

    fn secret_flags(secrets: &[&str], env: &[&str], hosts: &[&str]) -> SecretFlags {
        SecretFlags {
            secrets: secrets.iter().map(|s| s.to_string()).collect(),
            secret_env: env.iter().map(|s| s.to_string()).collect(),
            hosts: hosts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn test_secret_flags_direct_value_defaults_placeholder_and_hosts() {
        let mut opts = BoxOptions::default();
        secret_flags(&["openai=sk-123"], &[], &["openai=api.openai.com"])
            .apply_to(&mut opts)
            .expect("valid secret flags");

        assert_eq!(opts.secrets.len(), 1);
        let s = &opts.secrets[0];
        assert_eq!(s.name, "openai");
        assert_eq!(s.value, "sk-123");
        assert_eq!(s.hosts, vec!["api.openai.com"]);
        // The placeholder is derived from the name so the local runtime (which
        // does not synthesize a default) still substitutes.
        assert_eq!(s.placeholder, "<BOXLITE_SECRET:openai>");
    }

    #[test]
    fn test_secret_flags_are_repeatable_and_accumulate_hosts() {
        let mut opts = BoxOptions::default();
        secret_flags(&["a=1", "b=2"], &[], &["a=h1", "a=h2", "b=*.example.com"])
            .apply_to(&mut opts)
            .expect("repeatable flags");

        assert_eq!(opts.secrets.len(), 2);
        assert_eq!(opts.secrets[0].name, "a");
        assert_eq!(opts.secrets[0].hosts, vec!["h1", "h2"]);
        assert_eq!(opts.secrets[1].name, "b");
        assert_eq!(opts.secrets[1].hosts, vec!["*.example.com"]);
    }

    #[test]
    fn test_secret_flags_read_value_from_env() {
        let mut opts = BoxOptions::default();
        secret_flags(&[], &["openai=OPENAI_KEY"], &["openai=api.openai.com"])
            .apply_to_with_lookup(&mut opts, |k| {
                (k == "OPENAI_KEY").then(|| "sk-env".to_string())
            })
            .expect("env source");

        assert_eq!(opts.secrets[0].value, "sk-env");
        assert_eq!(opts.secrets[0].placeholder, "<BOXLITE_SECRET:openai>");
    }

    #[test]
    fn test_secret_flags_missing_env_variable_is_rejected() {
        let mut opts = BoxOptions::default();
        let err = secret_flags(&[], &["openai=NOT_SET"], &["openai=h"])
            .apply_to_with_lookup(&mut opts, |_| None)
            .expect_err("unset env var must error");

        assert!(err.to_string().contains("NOT_SET"), "{err}");
    }

    #[test]
    fn test_secret_flags_malformed_args_are_rejected() {
        for (secrets, env, hosts) in [
            (vec!["openai"], vec![], vec!["openai=h"]), // no '='
            (vec!["=v"], vec![], vec!["openai=h"]),     // empty name
            (vec!["n="], vec![], vec!["n=h"]),          // empty value
            (vec!["openai=sk"], vec![], vec!["=h"]),    // empty host name
        ] {
            let mut opts = BoxOptions::default();
            let err = secret_flags(&secrets, &env, &hosts)
                .apply_to(&mut opts)
                .expect_err("malformed args must error");
            assert!(
                err.to_string().contains("NAME=VALUE")
                    || err.to_string().contains("must not be empty"),
                "{err}"
            );
        }
    }

    #[test]
    fn test_secret_flags_require_a_host_rule() {
        let mut opts = BoxOptions::default();
        let err = secret_flags(&["openai=sk"], &[], &[])
            .apply_to(&mut opts)
            .expect_err("host-less secret must error");

        assert!(err.to_string().contains("--secret-host"), "{err}");
    }

    #[test]
    fn test_secret_flags_orphan_host_rule_is_rejected() {
        let mut opts = BoxOptions::default();
        let err = secret_flags(&[], &[], &["openai=h"])
            .apply_to(&mut opts)
            .expect_err("orphan host rule must error");

        assert!(err.to_string().contains("no matching"), "{err}");
    }

    #[test]
    fn test_secret_flags_duplicate_name_is_rejected() {
        let mut opts = BoxOptions::default();
        let err = secret_flags(&["openai=a", "openai=b"], &[], &["openai=h"])
            .apply_to(&mut opts)
            .expect_err("duplicate name must error");

        assert!(err.to_string().contains("duplicate secret name"), "{err}");
    }

    #[test]
    fn test_secret_flags_default_left_untouched() {
        let mut opts = BoxOptions::default();
        secret_flags(&[], &[], &[])
            .apply_to(&mut opts)
            .expect("no-op apply");

        assert!(opts.secrets.is_empty());
    }

    #[test]
    fn experimental_flags_are_hidden_from_help() {
        for command in ["run", "create"] {
            let error = Cli::try_parse_from(["boxlite", command, "--help"]).unwrap_err();
            assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp);

            let help = error.to_string();
            for rc_flag in [
                "--kernel",
                "--kernel-format",
                "--initramfs",
                "--kernel-args",
                "--nested-virtualization",
            ] {
                assert!(
                    !help.contains(rc_flag),
                    "{rc_flag} leaked into {command} help:\n{help}"
                );
            }
            assert!(
                !help.contains("\nAdvanced boot options:\n"),
                "empty advanced boot section leaked into {command} help:\n{help}"
            );
        }
    }

    #[test]
    fn experimental_flags_are_hidden_from_completions() {
        for shell in [Shell::Bash, Shell::Zsh, Shell::Fish] {
            let mut output = Vec::new();
            generate_completion(&shell, &mut Cli::command(), "boxlite", &mut output);
            let completion = String::from_utf8(output).unwrap();

            for name in [
                "kernel",
                "kernel-format",
                "initramfs",
                "kernel-args",
                "nested-virtualization",
            ] {
                let rc_flag = match shell {
                    Shell::Fish => format!("-l {name}"),
                    Shell::Bash | Shell::Zsh => format!("--{name}"),
                };
                assert!(
                    !completion.contains(&rc_flag),
                    "{rc_flag} leaked into {shell:?} completion"
                );
            }
            for name in ["rootfs", "cpus", "network"] {
                let stable_flag = match shell {
                    Shell::Fish => format!("-l {name}"),
                    Shell::Bash | Shell::Zsh => format!("--{name}"),
                };
                assert!(
                    completion.contains(&stable_flag),
                    "{stable_flag} missing from {shell:?} completion"
                );
            }
        }
    }

    #[test]
    fn kernel_companion_flags_require_kernel() {
        let error = Cli::try_parse_from([
            "boxlite",
            "run",
            "--initramfs",
            "/tmp/initramfs.img",
            "alpine",
        ])
        .unwrap_err();

        assert_eq!(
            error.kind(),
            clap::error::ErrorKind::MissingRequiredArgument
        );
    }

    fn network_flags(network: Option<&str>, allow_net: &[&str]) -> NetworkFlags {
        NetworkFlags {
            network: network.map(str::to_string),
            allow_net: allow_net.iter().map(|s| s.to_string()).collect(),
            inbound: None,
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

        assert!(err.to_string().contains("network mode"));
    }

    #[test]
    fn test_network_flags_inbound_disabled_sets_private() {
        // --inbound disabled alone (no --network/--allow-net) still applies,
        // and leaves outbound at its Enabled/full-access default.
        let mut opts = BoxOptions::default();
        let mut flags = network_flags(None, &[]);
        flags.inbound = Some("disabled".to_string());
        flags.apply_to(&mut opts).expect("disabled is valid");

        assert!(matches!(opts.inbound_network, NetworkSpec::Disabled));
        assert!(
            matches!(opts.network, NetworkSpec::Enabled { ref allow_net } if allow_net.is_empty())
        );
    }

    #[test]
    fn cli_rejects_inbound_allow_net_flag() {
        // The flag is deliberately not exposed until inbound allowlist
        // enforcement exists — a flag that always errors would advertise a
        // feature that doesn't work.
        let err = Cli::try_parse_from([
            "boxlite",
            "run",
            "--inbound-allow-net",
            "10.0.0.0/8",
            "alpine:latest",
        ])
        .expect_err("unknown flag must fail parsing");
        assert_eq!(err.kind(), clap::error::ErrorKind::UnknownArgument);
    }

    #[test]
    fn cli_parses_run_with_inbound_flags() {
        let cli = Cli::try_parse_from(["boxlite", "run", "--inbound", "disabled", "alpine:latest"])
            .expect("parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected Run")
        };
        assert_eq!(args.network.inbound.as_deref(), Some("disabled"));
    }

    #[test]
    fn test_network_flags_invalid_inbound_mode_is_rejected() {
        let mut opts = BoxOptions::default();
        let mut flags = network_flags(None, &[]);
        flags.inbound = Some("bridge".to_string());
        let err = flags
            .apply_to(&mut opts)
            .expect_err("unknown inbound mode must error");

        assert!(err.to_string().contains("network mode"));
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

    /// `-t` has to reach `BoxOptions.tty`, because the terminal now belongs to
    /// the *container's* init rather than to an exec: nothing downstream can
    /// add it later. When this mapping was missing, `run -it` still parsed,
    /// still put the local terminal in raw mode, and still ran — just against a
    /// process on pipes, with no prompt and no job control.
    #[test]
    fn test_process_flags_tty_reaches_box_options() {
        let mut opts = BoxOptions::default();
        assert!(!opts.tty, "a box is not a terminal by default");

        let mut flags = process_flags_with_entrypoint(None);
        flags.tty = true;
        flags.apply_to(&mut opts).expect("tty apply");

        assert!(opts.tty, "-t must make the main command a terminal");
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
    fn test_parse_publish_spec_udp_is_rejected() {
        let err = super::parse_publish_spec("53:53/udp").unwrap_err();
        assert!(err.to_string().contains("UDP port forwarding"));
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

    /// `-v my-data:/data` reaches `BoxOptions` as a managed volume, not a host
    /// bind — the whole point of adopting Docker's rule. It must not touch the
    /// filesystem on the way: no canonicalize, no "path does not exist".
    #[test]
    fn test_volume_flags_apply_to_managed_volume() {
        let flags = VolumeFlags {
            volume: vec![
                "my-data:/data".to_string(),
                "vol_01K2EXAMPLE:/cache".to_string(),
            ],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, None).unwrap();

        assert_eq!(opts.volumes.len(), 2);
        assert_eq!(opts.volumes[0].managed_volume.as_deref(), Some("my-data"));
        assert_eq!(opts.volumes[0].host_path, "");
        assert_eq!(opts.volumes[0].guest_path, "/data");
        assert!(!opts.volumes[0].read_only);
        assert_eq!(
            opts.volumes[1].managed_volume.as_deref(),
            Some("vol_01K2EXAMPLE")
        );
        assert_eq!(opts.volumes[1].guest_path, "/cache");
    }

    /// `:ro` on a managed volume is refused, not quietly downgraded. Neither
    /// the server nor the REST client accepts one, and a caller who believes a
    /// mount is protected when it is writable is the failure worth preventing.
    #[test]
    fn test_volume_flags_reject_read_only_managed_volume() {
        let flags = VolumeFlags {
            volume: vec!["my-data:/data:ro".to_string()],
        };
        let mut opts = BoxOptions::default();

        let error = flags
            .apply_to(&mut opts, None)
            .expect_err("read-only managed volumes must be refused")
            .to_string();

        assert!(error.contains("read-only"), "{error}");
        assert!(error.contains("my-data"), "{error}");
        assert!(opts.volumes.is_empty());
    }

    /// A host bind may still be read-only — the restriction is specific to
    /// managed volumes, not to `:ro`.
    #[test]
    fn test_volume_flags_still_allow_read_only_host_binds() {
        let flags = VolumeFlags {
            volume: vec!["/host/data:/data:ro".to_string()],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, None).unwrap();

        assert_eq!(opts.volumes[0].host_path, "/host/data");
        assert!(opts.volumes[0].read_only);
    }

    /// A host bind keeps `managed_volume` unset, so the two `-v` forms stay
    /// distinguishable all the way to the wire.
    #[test]
    fn test_volume_flags_apply_to_leaves_host_binds_unmanaged() {
        let flags = VolumeFlags {
            volume: vec!["/host/data:/guest/data".to_string()],
        };
        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts, None).unwrap();

        assert_eq!(opts.volumes[0].managed_volume, None);
        assert_eq!(opts.volumes[0].host_path, "/host/data");
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

    use crate::commands::{auth::AuthCommand, network::NetworkCommand};
    use clap::Parser;

    // ─── tunnel parse tests ────────────────────────────────────────────────

    #[test]
    fn tunnel_parses_box_and_port() {
        let cli =
            Cli::try_parse_from(["boxlite", "network", "tunnel", "mybox", "3000"]).expect("parse");
        let Commands::Network(network) = cli.command else {
            panic!("expected Commands::Network");
        };
        let NetworkCommand::Tunnel(args) = network.command;
        assert_eq!(args.target, "mybox");
        assert_eq!(args.port, 3000);
        assert!(args.listen.is_none());
    }

    #[test]
    fn network_tunnel_accepts_listener_forms() {
        for listen in [
            "8080",
            "0",
            "127.0.0.1:8080",
            "[::1]:8080",
            "unix:/tmp/app.sock",
        ] {
            Cli::try_parse_from([
                "boxlite", "network", "tunnel", "mybox", "3000", "--listen", listen,
            ])
            .unwrap_or_else(|error| panic!("{listen} should parse: {error}"));
        }
    }

    #[test]
    fn network_tunnel_rejects_ambiguous_listener_forms() {
        for listen in [
            "localhost:8080",
            "::1:8080",
            ":8080",
            "unix:relative.sock",
            "127.0.0.1",
        ] {
            let result = Cli::try_parse_from([
                "boxlite", "network", "tunnel", "mybox", "3000", "--listen", listen,
            ]);
            assert!(result.is_err(), "{listen} must be rejected");
        }
    }

    #[test]
    fn tunnel_is_not_a_top_level_command() {
        let result = Cli::try_parse_from(["boxlite", "tunnel", "mybox", "3000"]);
        assert!(result.is_err(), "tunnel must be nested under network");
    }

    #[test]
    fn tunnel_rejects_port_zero_at_parse() {
        let result = Cli::try_parse_from(["boxlite", "network", "tunnel", "mybox", "0"]);
        assert!(result.is_err(), "port 0 must be rejected by the parser");
    }

    /// `boxlite port BOX` existed earlier on this branch and was withdrawn:
    /// resolved bindings are reported through `boxlite inspect`, and remote
    /// access goes through `boxlite network tunnel`.
    #[test]
    fn withdrawn_port_subcommand_is_rejected() {
        let result = Cli::try_parse_from(["boxlite", "port", "mybox"]);
        assert!(
            result.is_err(),
            "the withdrawn port command must not come back"
        );
    }

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

    // ─── volume subcommand parse tests ─────────────────────────────────────

    use crate::commands::volume::VolumeCommand;

    #[test]
    fn volume_create_takes_an_optional_name() {
        // Without --name the server names the volume after its id.
        let cli = Cli::try_parse_from(["boxlite", "volume", "create"]).expect("parse");
        let Commands::Volume(args) = cli.command else {
            panic!("expected Commands::Volume");
        };
        let VolumeCommand::Create(create) = args.command else {
            panic!("expected VolumeCommand::Create");
        };
        assert_eq!(create.name, None);

        let cli = Cli::try_parse_from(["boxlite", "volume", "create", "--name", "my-data"])
            .expect("parse");
        let Commands::Volume(args) = cli.command else {
            panic!("expected Commands::Volume");
        };
        let VolumeCommand::Create(create) = args.command else {
            panic!("expected VolumeCommand::Create");
        };
        assert_eq!(create.name.as_deref(), Some("my-data"));

        // The name is a flag, not a positional: a bare argument is still rejected.
        assert!(Cli::try_parse_from(["boxlite", "volume", "create", "data"]).is_err());
    }

    #[test]
    fn volume_ls_list_alias_parses() {
        // The `list` visible alias must resolve to the same Ls variant.
        for verb in ["ls", "list"] {
            let cli = Cli::try_parse_from(["boxlite", "volume", verb]).expect("parse");
            let Commands::Volume(args) = cli.command else {
                panic!("expected Commands::Volume for {verb}");
            };
            assert!(
                matches!(args.command, VolumeCommand::Ls(_)),
                "{verb} should map to Ls"
            );
        }
    }

    #[test]
    fn volume_get_inspect_alias_parses() {
        for verb in ["get", "inspect"] {
            let cli = Cli::try_parse_from(["boxlite", "volume", verb, "vol-123"]).expect("parse");
            let Commands::Volume(args) = cli.command else {
                panic!("expected Commands::Volume for {verb}");
            };
            let VolumeCommand::Get(get) = args.command else {
                panic!("{verb} should map to Get");
            };
            assert_eq!(get.id, "vol-123");
        }
    }

    #[test]
    fn volume_rm_takes_multiple_ids_and_force() {
        let cli = Cli::try_parse_from(["boxlite", "volume", "rm", "-f", "a", "b"]).expect("parse");
        let Commands::Volume(args) = cli.command else {
            panic!("expected Commands::Volume");
        };
        let VolumeCommand::Rm(rm) = args.command else {
            panic!("expected VolumeCommand::Rm");
        };
        assert!(rm.force);
        assert_eq!(rm.ids, vec!["a", "b"]);
    }

    #[test]
    fn volume_rm_requires_an_id() {
        // `num_args = 1..` + required means a bare `volume rm` must error.
        assert!(Cli::try_parse_from(["boxlite", "volume", "rm"]).is_err());
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
            nested_virtualization: false,
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
            nested_virtualization: false,
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
            nested_virtualization: false,
        };
        let mut opts = BoxOptions::default();
        let err = flags
            .apply_to(&mut opts)
            .expect_err("unknown preset must reject at apply_to");
        let msg = err.to_string();
        assert!(msg.contains("ultra"), "got {msg}");
    }

    #[test]
    fn nested_virtualization_flag_applies_to_box_options() {
        let cli =
            Cli::try_parse_from(["boxlite", "run", "--nested-virtualization", "alpine:latest"])
                .expect("nested virtualization flag should parse");
        let Commands::Run(args) = cli.command else {
            panic!("expected run command");
        };

        let mut opts = BoxOptions::default();
        assert!(!opts.advanced.nested_virtualization);
        args.management
            .apply_to(&mut opts)
            .expect("nested virtualization should apply");

        assert!(opts.advanced.nested_virtualization);
    }
}
