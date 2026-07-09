mod cli;
mod commands;
mod config;
mod credentials;
mod defaults;
mod formatter;
pub mod terminal;
pub mod util;

use std::path::{Path, PathBuf};
use std::process;
use std::sync::OnceLock;

use clap::CommandFactory;
use clap::Parser;
use cli::Cli;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, Layer, fmt, layer::SubscriberExt, util::SubscriberInitExt};

static FILE_LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

fn main() {
    let cli = Cli::parse();

    // Handle shell completion before starting tokio or tracing
    if let cli::Commands::Completion(args) = &cli.command {
        let mut cmd = Cli::command();
        cli::generate_completion(&args.shell, &mut cmd, "boxlite", &mut std::io::stdout());
        process::exit(0);
    }

    // Start tokio runtime manually to ensure environment is set up safely
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime");

    // `block_on` returns only after `run_cli` has fully unwound, so every
    // `BoxliteRuntime` it created has already dropped — firing
    // `RuntimeImpl::Drop` -> `shutdown_sync` and reaping any non-detached
    // box. Then we drop the tokio runtime itself and `process::exit` with
    // the propagated code. Calling `process::exit` here (vs. mid-command)
    // is safe because there is nothing left on the stack to clean up; doing
    // it inside `run_cli` would bypass that Drop chain and leak the shim
    // (#622).
    let code = rt.block_on(run_cli(cli));
    drop(rt);
    process::exit(code);
}

async fn run_cli(cli: Cli) -> i32 {
    // Per-layer filters: stderr stays peer-CLI quiet (warn), the optional file
    // layer carries richer info-level data for triage. Precedence (docker
    // convention): `--debug` flag > `RUST_LOG` env > per-layer default.
    let debug = cli.global.debug;
    // Read RUST_LOG once at startup so `build_filter` stays pure and
    // testable; tests can pass values directly without racing on the
    // global env. Read here (not inside `build_filter`) because the
    // function is called twice and the second call would otherwise race
    // any subsequent env mutation in the same process.
    let rust_log_env = std::env::var("RUST_LOG").ok();

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(build_filter(debug, "warn", rust_log_env.as_deref()));

    // For `boxlite serve`, the daemon's logs must land under the *resolved*
    // home_dir (config file + --home + BOXLITE_HOME), not just the --home flag.
    // Other subcommands resolve options later inside their handlers.
    //
    // The `.ok()` here is intentionally best-effort: this resolution is only
    // consulted for the log directory. In local mode the serve handler calls
    // `create_runtime()` which re-runs `resolve_runtime_options()` and
    // surfaces config errors to the user. In REST mode (`--url` /
    // `BOXLITE_API_KEY` set) the resolver is *not* re-invoked, so a malformed
    // config file is silently ignored here; `boxlite serve` is overwhelmingly
    // a local-daemon operation, so we accept that narrow gap rather than
    // duplicating the resolver call here.
    let serve_mode = matches!(cli.command, cli::Commands::Serve(_));
    let serve_home_dir = if serve_mode {
        cli.global
            .resolve_runtime_options()
            .ok()
            .map(|o| o.home_dir)
    } else {
        None
    };
    let file_layer = build_file_layer(
        serve_home_dir.as_deref(),
        serve_mode,
        debug,
        rust_log_env.as_deref(),
    );

    tracing_subscriber::registry()
        .with(stderr_layer)
        .with(file_layer)
        .init();

    let global = cli.global;
    // Only `run`/`exec` carry a meaningful shell exit code (the box's
    // mapped command exit); the rest are unit-success commands adapted to
    // `Ok(0)` here so the dispatcher can produce one `Result<i32>` overall.
    // Keeping the adapter at the call site (rather than pushing `i32` into
    // 15 commands that have no exit-code concept) preserves type honesty.
    let result: anyhow::Result<i32> = match cli.command {
        cli::Commands::Run(args) => commands::run::execute(args, &global).await,
        cli::Commands::Exec(args) => commands::exec::execute(args, &global).await,
        cli::Commands::Create(args) => commands::create::execute(args, &global).await.map(|_| 0),
        cli::Commands::List(args) => commands::list::execute(args, &global).await.map(|_| 0),
        cli::Commands::Rm(args) => commands::rm::execute(args, &global).await.map(|_| 0),
        cli::Commands::Start(args) => commands::start::execute(args, &global).await.map(|_| 0),
        cli::Commands::Stop(args) => commands::stop::execute(args, &global).await.map(|_| 0),
        cli::Commands::Restart(args) => commands::restart::execute(args, &global).await.map(|_| 0),
        cli::Commands::Pull(args) => commands::pull::execute(args, &global).await.map(|_| 0),
        cli::Commands::Images(args) => commands::images::execute(args, &global).await.map(|_| 0),
        cli::Commands::Inspect(args) => commands::inspect::execute(args, &global).await.map(|_| 0),
        cli::Commands::Cp(args) => commands::cp::execute(args, &global).await.map(|_| 0),
        cli::Commands::Info(args) => commands::info::execute(args, &global).await.map(|_| 0),
        cli::Commands::Logs(args) => commands::logs::execute(args, &global).await.map(|_| 0),
        cli::Commands::Stats(args) => commands::stats::execute(args, &global).await.map(|_| 0),
        cli::Commands::Tunnel(args) => commands::tunnel::execute(args, &global).await.map(|_| 0),
        cli::Commands::Serve(args) => commands::serve::execute(args, &global).await.map(|_| 0),
        cli::Commands::Auth(args) => commands::auth::run(args, &global).await.map(|_| 0),
        cli::Commands::Volume(args) => commands::volume::execute(args, &global).await.map(|_| 0),
        // Handled in main() before tokio; never reaches run_cli
        cli::Commands::Completion(_) => {
            unreachable!("completion subcommand is handled before tokio in main()")
        }
    };

    match result {
        Ok(code) => code,
        Err(error) => {
            // `{:#}` prints the anyhow chain (outer context: inner cause: ...),
            // not just the outer message. Without this, `.with_context()` calls
            // swallow the underlying reqwest / openidconnect failure that the
            // user actually needs to see.
            eprintln!("Error: {:#}", error);
            1
        }
    }
}

/// Build a tracing filter with docker-style precedence:
/// `--debug` flag > `RUST_LOG` env > `default_level`.
///
/// When `--debug` is set, `RUST_LOG` is intentionally bypassed — the flag is a
/// per-invocation override and should not be silently nullified by ambient env.
///
/// `rust_log` is the snapshot of `RUST_LOG` taken once at the call site so
/// this function stays pure (no env reads) and the precedence tests can
/// pass values directly without racing on the process-global env.
fn build_filter(debug: bool, default_level: &str, rust_log: Option<&str>) -> EnvFilter {
    if debug {
        return EnvFilter::new("debug");
    }
    if let Some(value) = rust_log.filter(|v| !v.is_empty())
        && let Ok(filter) = EnvFilter::try_new(value)
    {
        return filter;
    }
    EnvFilter::try_new(default_level).unwrap_or_else(|_| EnvFilter::new(default_level))
}

/// Resolve the explicit `BOXLITE_LOG_FILE` value into `(dir, filename)`.
///
/// A bare filename (`BOXLITE_LOG_FILE=boxlite.log`) is treated as
/// CWD-relative: `Path::parent` returns `Some("")` for those, which we map to
/// `"."` so the file lands in the working directory rather than being silently
/// dropped. Returns `None` only when the value has no usable filename.
fn resolve_explicit_log_path(value: &str) -> Option<(PathBuf, String)> {
    let path = PathBuf::from(value);
    let filename = path.file_name()?.to_string_lossy().into_owned();
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        // None (root) or empty (bare filename) → CWD.
        _ => PathBuf::from("."),
    };
    Some((dir, filename))
}

/// Prepare the serve-mode log directory, returning the resolved path on
/// success or the underlying `io::Error` on failure.
///
/// Extracted so the caller can `eprintln!` a visible warning when the
/// daemon's log directory cannot be created — a silent fallback would
/// leave operators wondering why `<home>/logs/serve.log` never appears.
fn prepare_serve_log_dir(serve_home: &Path) -> std::io::Result<PathBuf> {
    let logs_dir = boxlite::runtime::layout::FilesystemLayout::logs_dir_for(serve_home);
    std::fs::create_dir_all(&logs_dir)?;
    Ok(logs_dir)
}

/// Build an optional JSON file-logging layer with its own filter.
///
/// Two paths to enabling a file sink:
///   1. Explicit: `BOXLITE_LOG_FILE=/path/to/log` (any subcommand, no rotation).
///      Bare filenames are CWD-relative.
///   2. Implicit: `boxlite serve` — defaults to `<home>/logs/serve.log` with
///      daily rotation since the daemon mode is the canonical file-logging case.
///
/// The file layer defaults to `info` (richer than stderr's `warn` floor);
/// `--debug` and `RUST_LOG` override per `build_filter` precedence.
fn build_file_layer<S>(
    serve_home: Option<&Path>,
    serve_mode: bool,
    debug: bool,
    rust_log: Option<&str>,
) -> Option<Box<dyn Layer<S> + Send + Sync + 'static>>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    let writer = if let Some(path_str) = std::env::var("BOXLITE_LOG_FILE")
        .ok()
        .filter(|p| !p.is_empty())
    {
        let (dir, filename) = resolve_explicit_log_path(&path_str)?;
        // Explicit user-set path: silent fallback is defensible (the user
        // chose this path; if it's unwritable, that's their immediate
        // problem and stderr logging continues).
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::never(dir, filename);
        let (non_blocking, guard) = tracing_appender::non_blocking(appender);
        let _ = FILE_LOG_GUARD.set(guard);
        non_blocking
    } else if serve_mode {
        let home_dir = serve_home?;
        // Serve-mode daemon: fail loudly. A silent skip here is the exact
        // operational footgun that motivates file logging in the first
        // place (long-lived daemon, no terminal scrollback to recover).
        let logs_dir = match prepare_serve_log_dir(home_dir) {
            Ok(p) => p,
            Err(err) => {
                eprintln!(
                    "warning: could not create log dir {}: {}; serve logs will be stderr only",
                    boxlite::runtime::layout::FilesystemLayout::logs_dir_for(home_dir).display(),
                    err,
                );
                return None;
            }
        };
        let appender = tracing_appender::rolling::daily(&logs_dir, "serve.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(appender);
        let _ = FILE_LOG_GUARD.set(guard);
        non_blocking
    } else {
        return None;
    };

    Some(
        fmt::layer()
            .json()
            .with_writer(writer)
            .with_ansi(false)
            .with_filter(build_filter(debug, "info", rust_log))
            .boxed(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `--debug` overrides `RUST_LOG` (docker-style precedence). A stale
    /// ambient `RUST_LOG=warn` must not nullify an explicit `--debug` flag.
    ///
    /// Pure: `build_filter` takes the env snapshot as a parameter, so this
    /// test is order-independent under parallel execution (no global env
    /// mutation, no cross-test races).
    #[test]
    fn build_filter_debug_flag_overrides_rust_log_env() {
        let filter = build_filter(true, "warn", Some("warn"));
        // EnvFilter's Display renders the directive set; "debug" indicates
        // the flag won over the ambient env.
        assert_eq!(filter.to_string(), "debug");
    }

    /// `RUST_LOG` wins over the per-layer default when `--debug` is unset.
    #[test]
    fn build_filter_rust_log_overrides_default_when_no_debug() {
        let filter = build_filter(false, "warn", Some("error"));
        assert_eq!(filter.to_string(), "error");
    }

    /// No `RUST_LOG` value falls through to the per-layer default.
    #[test]
    fn build_filter_falls_back_to_default_when_no_rust_log() {
        let filter = build_filter(false, "warn", None);
        assert_eq!(filter.to_string(), "warn");
        let filter_empty = build_filter(false, "warn", Some(""));
        assert_eq!(filter_empty.to_string(), "warn");
    }

    /// `BOXLITE_LOG_FILE=boxlite.log` (no directory component) must resolve
    /// to `(., boxlite.log)` so the file lands in the working directory
    /// rather than being silently dropped.
    #[test]
    fn resolve_explicit_log_path_bare_filename_is_cwd_relative() {
        let (dir, filename) = resolve_explicit_log_path("boxlite.log")
            .expect("bare filename should resolve, not be dropped");
        assert_eq!(dir, PathBuf::from("."));
        assert_eq!(filename, "boxlite.log");
    }

    #[test]
    fn resolve_explicit_log_path_absolute_path_splits_correctly() {
        let (dir, filename) = resolve_explicit_log_path("/tmp/boxlite/app.log").unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/boxlite"));
        assert_eq!(filename, "app.log");
    }

    #[test]
    fn resolve_explicit_log_path_relative_path_splits_correctly() {
        let (dir, filename) = resolve_explicit_log_path("logs/app.log").unwrap();
        assert_eq!(dir, PathBuf::from("logs"));
        assert_eq!(filename, "app.log");
    }

    /// `prepare_serve_log_dir` must surface an `io::Error` when the home
    /// directory cannot host a `logs/` subdir. Caller uses the error to
    /// emit a visible warning instead of silently dropping file logs.
    #[test]
    fn prepare_serve_log_dir_surfaces_mkdir_error() {
        // `/dev/null` is a character device on Linux/macOS — creating a
        // subdir under it must fail at the OS level, giving us an Err to
        // assert on without needing chmod / mock filesystems.
        let home = PathBuf::from("/dev/null");
        let result = prepare_serve_log_dir(&home);
        assert!(
            result.is_err(),
            "creating logs/ under /dev/null must fail, got Ok({:?})",
            result.ok(),
        );
    }

    /// Happy path: `prepare_serve_log_dir` creates `<home>/logs` and
    /// returns its absolute path.
    #[test]
    fn prepare_serve_log_dir_creates_and_returns_logs_subdir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let logs_dir =
            prepare_serve_log_dir(tmp.path()).expect("mkdir on writable tempdir should succeed");
        assert_eq!(logs_dir, tmp.path().join("logs"));
        assert!(logs_dir.is_dir(), "logs dir should exist after mkdir");
    }
}
