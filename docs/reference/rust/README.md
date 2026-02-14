# Rust API Reference

Complete API reference for the BoxLite Rust SDK.

## Overview

The Rust SDK is the core implementation of BoxLite. It provides async-first APIs built on Tokio for creating and managing isolated VM environments.

**Crate**: `boxlite`
**Repository**: [github.com/anthropics/boxlite](https://github.com/anthropics/boxlite)

---

## Table of Contents

- [Runtime Management](#runtime-management)
  - [BoxliteRuntime](#boxliteruntime)
  - [BoxliteOptions](#boxliteoptions)
- [Box Handle](#box-handle)
  - [LiteBox](#litebox)
  - [BoxInfo](#boxinfo)
  - [BoxStatus](#boxstatus)
  - [BoxState](#boxstate)
- [Command Execution](#command-execution)
  - [BoxCommand](#boxcommand)
  - [Execution](#execution)
  - [ExecStdin](#execstdin)
  - [ExecStdout / ExecStderr](#execstdout--execstderr)
  - [ExecResult](#execresult)
- [Box Configuration](#box-configuration)
  - [BoxOptions](#boxoptions)
  - [AdvancedBoxOptions](#advancedoptions)
  - [RootfsSpec](#rootfsspec)
  - [VolumeSpec](#volumespec)
  - [NetworkSpec](#networkspec)
  - [PortSpec](#portspec)
- [Security](#security)
  - [SecurityOptions](#securityoptions)
  - [SecurityOptionsBuilder](#securityoptionsbuilder)
  - [ResourceLimits](#resourcelimits)
- [Metrics](#metrics)
  - [RuntimeMetrics](#runtimemetrics)
  - [BoxMetrics](#boxmetrics)
- [Type Utilities](#type-utilities)
  - [Bytes](#bytes)
  - [Seconds](#seconds)
  - [BoxID](#boxid)
  - [ContainerID](#containerid)
- [Error Types](#error-types)
  - [BoxliteError](#boxliteerror)
  - [BoxliteResult](#boxliteresult)

---

## Runtime Management

### BoxliteRuntime

Main entry point for creating and managing boxes.

```rust
use boxlite::runtime::{BoxliteRuntime, BoxliteOptions, BoxOptions};

// Create with default options
let runtime = BoxliteRuntime::with_defaults()?;

// Create with custom options
let options = BoxliteOptions {
    home_dir: PathBuf::from("/custom/boxlite"),
    image_registries: vec!["ghcr.io/myorg".to_string()],
};
let runtime = BoxliteRuntime::new(options)?;

// Use global default runtime
let runtime = BoxliteRuntime::default_runtime();
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `new` | `fn new(options: BoxliteOptions) -> BoxliteResult<Self>` | Create runtime with options |
| `with_defaults` | `fn with_defaults() -> BoxliteResult<Self>` | Create with default options |
| `default_runtime` | `fn default_runtime() -> &'static Self` | Get/create global singleton |
| `try_default_runtime` | `fn try_default_runtime() -> Option<&'static Self>` | Get global if initialized |
| `init_default_runtime` | `fn init_default_runtime(options: BoxliteOptions) -> BoxliteResult<()>` | Initialize global with options |
| `create` | `async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox>` | Create a new box |
| `get` | `async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>>` | Get box by ID or name |
| `get_info` | `async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>>` | Get box info without handle |
| `list_info` | `async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>>` | List all boxes |
| `exists` | `async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool>` | Check if box exists |
| `metrics` | `async fn metrics(&self) -> RuntimeMetrics` | Get runtime-wide metrics |
| `remove` | `async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()>` | Remove box completely |

#### Example

```rust
use boxlite::runtime::{BoxliteRuntime, BoxOptions};
use boxlite::BoxCommand;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = BoxliteRuntime::with_defaults()?;

    // Create a box
    let options = BoxOptions::default();
    let litebox = runtime.create(options, Some("my-box".to_string())).await?;

    // Run a command
    let mut run = litebox.run(BoxCommand::new("echo").arg("Hello")).await?;
    let result = run.wait().await?;

    println!("Exit code: {}", result.exit_code);

    // Stop the box
    litebox.stop().await?;

    Ok(())
}
```

### BoxliteOptions

Runtime configuration options.

```rust
pub struct BoxliteOptions {
    /// Home directory for runtime data (~/.boxlite by default)
    pub home_dir: PathBuf,

    /// Registries to search for unqualified image references
    /// Empty list uses docker.io as implicit default
    pub image_registries: Vec<String>,
}
```

#### Example

```rust
use boxlite::runtime::BoxliteOptions;
use std::path::PathBuf;

let options = BoxliteOptions {
    home_dir: PathBuf::from("/var/lib/boxlite"),
    image_registries: vec![
        "ghcr.io/myorg".to_string(),
        "docker.io".to_string(),
    ],
};
// "alpine" → tries ghcr.io/myorg/alpine, then docker.io/alpine
```

---

## Box Handle

### LiteBox

Handle to a box instance. Thin wrapper providing access to box operations.

```rust
pub struct LiteBox {
    // ... internal fields
}
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `id` | `fn id(&self) -> &BoxID` | Get box ID |
| `name` | `fn name(&self) -> Option<&str>` | Get optional box name |
| `info` | `fn info(&self) -> BoxInfo` | Get box info (no VM init) |
| `start` | `async fn start(&self) -> BoxliteResult<()>` | Start the box |
| `run` | `async fn run(&self, command: BoxCommand) -> BoxliteResult<Execution>` | Run command |
| `metrics` | `async fn metrics(&self) -> BoxliteResult<BoxMetrics>` | Get box metrics |
| `stop` | `async fn stop(&self) -> BoxliteResult<()>` | Stop the box |

#### Lifecycle

- `start()` initializes VM for `Configured` or `Stopped` boxes
- Idempotent: calling on `Running` box is a no-op
- `run()` implicitly calls `start()` if needed
- `stop()` terminates VM; box can be restarted

#### Example

```rust
let litebox = runtime.create(BoxOptions::default(), None).await?;

// Start explicitly (optional, run does this automatically)
litebox.start().await?;

// Check metrics
let metrics = litebox.metrics().await?;
println!("CPU: {:?}%", metrics.cpu_percent());

// Stop when done
litebox.stop().await?;
```

### BoxInfo

Public metadata about a box (returned by list operations).

```rust
pub struct BoxInfo {
    /// Unique box identifier (ULID)
    pub id: BoxID,

    /// User-defined name (optional)
    pub name: Option<String>,

    /// Current lifecycle status
    pub status: BoxStatus,

    /// Creation timestamp (UTC)
    pub created_at: DateTime<Utc>,

    /// Last state change timestamp (UTC)
    pub last_updated: DateTime<Utc>,

    /// Process ID of VMM subprocess (None if not running)
    pub pid: Option<u32>,

    /// Image reference or rootfs path
    pub image: String,

    /// Allocated CPU count
    pub cpus: u8,

    /// Allocated memory in MiB
    pub memory_mib: u32,

    /// User-defined labels
    pub labels: HashMap<String, String>,
}
```

### BoxStatus

Lifecycle status of a box.

```rust
pub enum BoxStatus {
    /// Cannot determine state (error recovery)
    Unknown,

    /// Created and persisted, VM not started
    Configured,

    /// Running and accepting commands
    Running,

    /// Shutting down gracefully (transient)
    Stopping,

    /// Not running, can be restarted
    Stopped,
}
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `is_active` | `fn is_active(&self) -> bool` | True if VM process running |
| `is_running` | `fn is_running(&self) -> bool` | True if Running |
| `is_configured` | `fn is_configured(&self) -> bool` | True if Configured |
| `is_stopped` | `fn is_stopped(&self) -> bool` | True if Stopped |
| `is_transient` | `fn is_transient(&self) -> bool` | True if Stopping |
| `can_start` | `fn can_start(&self) -> bool` | True if Configured or Stopped |
| `can_stop` | `fn can_stop(&self) -> bool` | True if Running |
| `can_remove` | `fn can_remove(&self) -> bool` | True if Configured, Stopped, or Unknown |
| `can_run` | `fn can_run(&self) -> bool` | True if Configured, Running, or Stopped |

#### State Machine

```
create() → Configured (persisted to DB, no VM)
start()  → Running (VM initialized)
stop()   → Stopped (VM terminated, can restart)
```

### BoxState

Dynamic box state (changes during lifecycle).

```rust
pub struct BoxState {
    /// Current lifecycle status
    pub status: BoxStatus,

    /// Process ID (None if not running)
    pub pid: Option<u32>,

    /// Container ID (64-char hex)
    pub container_id: Option<ContainerID>,

    /// Last state change timestamp (UTC)
    pub last_updated: DateTime<Utc>,

    /// Lock ID for multiprocess-safe locking
    pub lock_id: Option<LockId>,
}
```

---

## Command Execution

### BoxCommand

Command builder for running programs in a box.

```rust
use boxlite::BoxCommand;
use std::time::Duration;

let cmd = BoxCommand::new("python3")
    .args(["-c", "print('hello')"])
    .env("PYTHONPATH", "/app")
    .timeout(Duration::from_secs(30))
    .working_dir("/workspace")
    .tty(true);
```

#### Builder Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `new` | `fn new(command: impl Into<String>) -> Self` | Create command |
| `arg` | `fn arg(self, arg: impl Into<String>) -> Self` | Add single argument |
| `args` | `fn args<I, S>(self, args: I) -> Self` | Add multiple arguments |
| `env` | `fn env(self, key: impl Into<String>, val: impl Into<String>) -> Self` | Set env var |
| `timeout` | `fn timeout(self, timeout: Duration) -> Self` | Set run timeout |
| `working_dir` | `fn working_dir(self, dir: impl Into<String>) -> Self` | Set working directory |
| `tty` | `fn tty(self, enable: bool) -> Self` | Enable pseudo-terminal |

### Execution

Handle to a running command.

```rust
use boxlite::BoxCommand;
use futures::StreamExt;

let mut run_handle = litebox.run(BoxCommand::new("ls").arg("-la")).await?;

// Read stdout as stream
let mut stdout = run_handle.stdout().unwrap();
while let Some(line) = stdout.next().await {
    println!("{}", line);
}

// Wait for completion
let status = run_handle.wait().await?;
println!("Exit code: {}", status.exit_code);
```

#### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `id` | `fn id(&self) -> &ExecutionId` | Get run ID |
| `stdin` | `fn stdin(&mut self) -> Option<ExecStdin>` | Take stdin stream (once) |
| `stdout` | `fn stdout(&mut self) -> Option<ExecStdout>` | Take stdout stream (once) |
| `stderr` | `fn stderr(&mut self) -> Option<ExecStderr>` | Take stderr stream (once) |
| `wait` | `async fn wait(&mut self) -> BoxliteResult<ExecResult>` | Wait for completion |
| `kill` | `async fn kill(&mut self) -> BoxliteResult<()>` | Send SIGKILL |
| `signal` | `async fn signal(&self, signal: i32) -> BoxliteResult<()>` | Send signal |
| `resize_tty` | `async fn resize_tty(&self, rows: u32, cols: u32) -> BoxliteResult<()>` | Resize PTY |

### ExecStdin

Standard input stream (write-only).

```rust
pub struct ExecStdin {
    // ...
}

impl ExecStdin {
    /// Write data to stdin
    pub async fn write(&mut self, data: &[u8]) -> BoxliteResult<()>;

    /// Write all data to stdin
    pub async fn write_all(&mut self, data: &[u8]) -> BoxliteResult<()>;
}
```

#### Example

```rust
let mut run_handle = litebox.run(BoxCommand::new("cat")).await?;

// Get stdin handle
let mut stdin = run_handle.stdin().unwrap();

// Write data
stdin.write(b"Hello from stdin!\n").await?;
stdin.write_all(b"More data\n").await?;

// Drop stdin to close (signals EOF to process)
drop(stdin);

let result = run_handle.wait().await?;
```

### ExecStdout / ExecStderr

Standard output/error streams (read-only). Implements `futures::Stream<Item = String>`.

```rust
use futures::StreamExt;

let mut run_handle = litebox.run(BoxCommand::new("ls")).await?;

// Read stdout
let mut stdout = run_handle.stdout().unwrap();
while let Some(line) = stdout.next().await {
    println!("stdout: {}", line);
}

// Read stderr
let mut stderr = run_handle.stderr().unwrap();
while let Some(line) = stderr.next().await {
    eprintln!("stderr: {}", line);
}
```

#### Concurrent Reading

```rust
use futures::StreamExt;
use tokio::select;

let mut run_handle = litebox.run(BoxCommand::new("my-command")).await?;
let mut stdout = run_handle.stdout().unwrap();
let mut stderr = run_handle.stderr().unwrap();

loop {
    select! {
        Some(line) = stdout.next() => println!("stdout: {}", line),
        Some(line) = stderr.next() => eprintln!("stderr: {}", line),
        else => break,
    }
}
```

### ExecResult

Exit status of a process.

```rust
pub struct ExecResult {
    /// Exit code (0 = success, negative = signal number)
    pub exit_code: i32,
}

impl ExecResult {
    /// Returns true if exit code was 0
    pub fn success(&self) -> bool;

    /// Get exit code
    pub fn code(&self) -> i32;
}
```

---

## Box Configuration

### BoxOptions

Options for constructing a box.

```rust
pub struct BoxOptions {
    /// Number of CPUs (default: 2)
    pub cpus: Option<u8>,

    /// Memory in MiB (default: 512)
    pub memory_mib: Option<u32>,

    /// Disk size in GB for rootfs (sparse, grows as needed)
    pub disk_size_gb: Option<u64>,

    /// Working directory inside box
    pub working_dir: Option<String>,

    /// Environment variables
    pub env: Vec<(String, String)>,

    /// Root filesystem source
    pub rootfs: RootfsSpec,

    /// Volume mounts
    pub volumes: Vec<VolumeSpec>,

    /// Network isolation mode
    pub network: NetworkSpec,

    /// Port mappings
    pub ports: Vec<PortSpec>,

    /// Auto-remove box when stopped (default: true)
    pub auto_remove: bool,

    /// Run independently of parent process (default: false)
    pub detach: bool,

    /// Advanced options for expert users (security, mount isolation). Defaults are secure.
    pub advanced: AdvancedBoxOptions,
}
```

#### Example

```rust
use boxlite::runtime::options::{BoxOptions, RootfsSpec, VolumeSpec, PortSpec};

let options = BoxOptions {
    cpus: Some(4),
    memory_mib: Some(2048),
    rootfs: RootfsSpec::Image("python:3.11".to_string()),
    env: vec![
        ("PYTHONPATH".to_string(), "/app".to_string()),
    ],
    volumes: vec![
        VolumeSpec {
            host_path: "/home/user/project".to_string(),
            guest_path: "/app".to_string(),
            read_only: false,
        },
    ],
    ports: vec![
        PortSpec {
            host_port: Some(8080),
            guest_port: 80,
            ..Default::default()
        },
    ],
    auto_remove: false,  // Keep box after stop
    detach: true,        // Run independently
    ..Default::default()
};
```

### AdvancedBoxOptions

Advanced options for expert users. Most users can ignore this — defaults prioritize compatibility.

```rust
pub struct AdvancedBoxOptions {
    pub security: SecurityOptions,
    pub isolate_mounts: bool,
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `security` | `SecurityOptions` | Compatibility defaults | Security isolation options (jailer, seccomp, namespaces) |
| `isolate_mounts` | `bool` | `false` | Enable bind mount isolation (requires CAP_SYS_ADMIN on Linux) |

### RootfsSpec

How to populate the box root filesystem.

```rust
pub enum RootfsSpec {
    /// Pull/resolve this registry image reference
    Image(String),

    /// Use already prepared rootfs at host path
    RootfsPath(String),
}

impl Default for RootfsSpec {
    fn default() -> Self {
        Self::Image("alpine:latest".into())
    }
}
```

### VolumeSpec

Filesystem mount specification.

```rust
pub struct VolumeSpec {
    /// Path on host
    pub host_path: String,

    /// Path inside guest
    pub guest_path: String,

    /// Mount as read-only
    pub read_only: bool,
}
```

### NetworkSpec

Network isolation options.

```rust
pub enum NetworkSpec {
    /// Isolated network with gvproxy (default)
    Isolated,
    // Host,    // Future: share host network
    // Custom,  // Future: custom network config
}
```

### PortSpec

Port mapping specification (host → guest).

```rust
pub struct PortSpec {
    /// Host port (None/0 = dynamically assigned)
    pub host_port: Option<u16>,

    /// Guest port to expose
    pub guest_port: u16,

    /// Protocol (TCP/UDP)
    pub protocol: PortProtocol,

    /// Bind IP (None = 0.0.0.0)
    pub host_ip: Option<String>,
}

pub enum PortProtocol {
    Tcp,  // default
    Udp,
}
```

---

## Security

### SecurityOptions

Security isolation options for a box.

```rust
pub struct SecurityOptions {
    /// Enable jailer isolation (Linux: seccomp/namespaces, macOS: sandbox-exec)
    pub jailer_enabled: bool,

    /// Enable seccomp syscall filtering (Linux only)
    pub seccomp_enabled: bool,

    /// UID to drop to (Linux only). None = auto-allocate
    pub uid: Option<u32>,

    /// GID to drop to (Linux only). None = auto-allocate
    pub gid: Option<u32>,

    /// Create new PID namespace (Linux only)
    pub new_pid_ns: bool,

    /// Create new network namespace (Linux only)
    pub new_net_ns: bool,

    /// Base directory for chroot jails (Linux)
    pub chroot_base: PathBuf,

    /// Enable chroot isolation (Linux only)
    pub chroot_enabled: bool,

    /// Close inherited file descriptors
    pub close_fds: bool,

    /// Sanitize environment variables
    pub sanitize_env: bool,

    /// Environment variables to preserve
    pub env_allowlist: Vec<String>,

    /// Resource limits
    pub resource_limits: ResourceLimits,

    /// Custom sandbox profile (macOS only)
    pub sandbox_profile: Option<PathBuf>,

    /// Enable network in sandbox (macOS only)
    pub network_enabled: bool,
}
```

#### Presets

```rust
// Development: minimal isolation for debugging
let dev = SecurityOptions::development();
// - jailer_enabled: false
// - seccomp_enabled: false
// - close_fds: false

// Default: compatibility-focused
let default_security = SecurityOptions::default();
// - jailer_enabled: false
// - seccomp_enabled: false

// Standard: recommended for most use cases
let std = SecurityOptions::standard();
// - jailer_enabled: true (Linux/macOS)
// - seccomp_enabled: true (Linux)

// Maximum: all isolation features
let max = SecurityOptions::maximum();
// - All isolation enabled
// - uid/gid: 65534 (nobody)
// - Resource limits applied
```

### SecurityOptionsBuilder

Fluent builder for security options.

```rust
use boxlite::runtime::options::{SecurityOptions, SecurityOptionsBuilder};

let security = SecurityOptionsBuilder::standard()
    .max_open_files(2048)
    .max_file_size_bytes(1024 * 1024 * 512)  // 512 MiB
    .max_processes(100)
    .allow_env("MY_VAR")
    .build();

// Or via SecurityOptions::builder()
let security = SecurityOptions::builder()
    .seccomp_enabled(false)
    .build();
```

#### Builder Methods

| Method | Description |
|--------|-------------|
| `new()` | Start from defaults |
| `development()` | Start from dev preset |
| `standard()` | Start from standard preset |
| `maximum()` | Start from max preset |
| `jailer_enabled(bool)` | Enable/disable jailer |
| `seccomp_enabled(bool)` | Enable/disable seccomp |
| `uid(u32)` | Set drop-to UID |
| `gid(u32)` | Set drop-to GID |
| `new_pid_ns(bool)` | Enable PID namespace |
| `new_net_ns(bool)` | Enable network namespace |
| `chroot_base(path)` | Set chroot base dir |
| `chroot_enabled(bool)` | Enable chroot |
| `close_fds(bool)` | Close inherited FDs |
| `sanitize_env(bool)` | Sanitize environment |
| `env_allowlist(vec)` | Set env allowlist |
| `allow_env(var)` | Add to env allowlist |
| `resource_limits(limits)` | Set all limits |
| `max_open_files(n)` | RLIMIT_NOFILE |
| `max_file_size_bytes(n)` | RLIMIT_FSIZE |
| `max_processes(n)` | RLIMIT_NPROC |
| `max_memory_bytes(n)` | RLIMIT_AS |
| `max_cpu_time_seconds(n)` | RLIMIT_CPU |
| `sandbox_profile(path)` | macOS sandbox profile |
| `network_enabled(bool)` | macOS network access |
| `build()` | Build SecurityOptions |

### ResourceLimits

Resource limits for the jailed process.

```rust
pub struct ResourceLimits {
    /// Max open file descriptors (RLIMIT_NOFILE)
    pub max_open_files: Option<u64>,

    /// Max file size in bytes (RLIMIT_FSIZE)
    pub max_file_size: Option<u64>,

    /// Max number of processes (RLIMIT_NPROC)
    pub max_processes: Option<u64>,

    /// Max virtual memory in bytes (RLIMIT_AS)
    pub max_memory: Option<u64>,

    /// Max CPU time in seconds (RLIMIT_CPU)
    pub max_cpu_time: Option<u64>,
}
```

---

## Metrics

### RuntimeMetrics

Runtime-wide metrics (aggregate across all boxes).

```rust
let metrics = runtime.metrics().await;
println!("Boxes created: {}", metrics.boxes_created_total());
println!("Commands run: {}", metrics.total_commands_run());
```

#### Methods

| Method | Return | Description |
|--------|--------|-------------|
| `boxes_created_total()` | `u64` | Total boxes created |
| `boxes_failed_total()` | `u64` | Total boxes that failed to start |
| `num_running_boxes()` | `u64` | Currently running boxes |
| `total_commands_run()` | `u64` | Total run() calls |
| `total_run_errors()` | `u64` | Total run errors |

### BoxMetrics

Per-box metrics (individual LiteBox statistics).

```rust
let metrics = litebox.metrics().await?;
println!("Boot time: {:?}ms", metrics.guest_boot_duration_ms());
println!("CPU: {:?}%", metrics.cpu_percent());
println!("Memory: {:?} bytes", metrics.memory_bytes());
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| `commands_run_total` | `u64` | Commands on this box |
| `run_errors_total` | `u64` | Run errors on this box |
| `bytes_sent_total` | `u64` | Bytes sent (stdin) |
| `bytes_received_total` | `u64` | Bytes received (stdout/stderr) |
| `total_create_duration_ms` | `Option<u128>` | Total init time |
| `guest_boot_duration_ms` | `Option<u128>` | Guest boot time |
| `cpu_percent` | `Option<f32>` | CPU usage (0-100) |
| `memory_bytes` | `Option<u64>` | Memory usage |
| `network_bytes_sent` | `Option<u64>` | Network TX |
| `network_bytes_received` | `Option<u64>` | Network RX |
| `network_tcp_connections` | `Option<u64>` | Active TCP connections |
| `network_tcp_errors` | `Option<u64>` | TCP connection errors |

#### Stage Timing

| Field | Description |
|-------|-------------|
| `stage_filesystem_setup_ms` | Stage 1: Directory setup |
| `stage_image_prepare_ms` | Stage 2: Image pull/extract |
| `stage_guest_rootfs_ms` | Stage 3: Guest rootfs bootstrap |
| `stage_box_config_ms` | Stage 4: Box config build |
| `stage_box_spawn_ms` | Stage 5: Subprocess spawn |
| `stage_container_init_ms` | Stage 6: Container init |

---

## Type Utilities

### Bytes

Semantic newtype for byte sizes.

```rust
use boxlite::runtime::types::Bytes;

// Constructors
let size = Bytes::from_bytes(1_000_000);
let size = Bytes::from_kib(512);   // 512 * 1024
let size = Bytes::from_mib(128);   // 128 * 1024²
let size = Bytes::from_gib(2);     // 2 * 1024³

// Accessors
let bytes = size.as_bytes();
let kib = size.as_kib();
let mib = size.as_mib();

// Display
println!("{}", Bytes::from_mib(512));  // "512 MiB"
```

### Seconds

Semantic newtype for durations.

```rust
use boxlite::runtime::types::Seconds;

// Constructors
let duration = Seconds::from_seconds(30);
let duration = Seconds::from_minutes(5);   // 300 seconds
let duration = Seconds::from_hours(1);     // 3600 seconds

// Accessors
let secs = duration.as_seconds();
let mins = duration.as_minutes();

// Display
println!("{}", Seconds::from_minutes(30));  // "30 minutes"
```

### BoxID

Box identifier in ULID format (26 characters, sortable).

```rust
use boxlite::runtime::types::BoxID;

let id = BoxID::new();
println!("Full: {}", id.as_str());   // "01HJK4TNRPQSXYZ8WM6NCVT9R5"
println!("Short: {}", id.short());    // "01HJK4TN"

// Validation
let valid = BoxID::parse("01HJK4TNRPQSXYZ8WM6NCVT9R5");
let invalid = BoxID::parse("too-short");  // None
```

### ContainerID

Container identifier (64-char lowercase hex, OCI format).

```rust
use boxlite::runtime::types::ContainerID;

let id = ContainerID::new();
println!("Full: {}", id.as_str());   // 64 hex chars
println!("Short: {}", id.short());    // 12 hex chars

// Validation
let valid = ContainerID::is_valid("a".repeat(64).as_str());  // true
```

---

## Error Types

### BoxliteError

Central error enum for all BoxLite operations.

```rust
pub enum BoxliteError {
    /// Unsupported engine kind
    UnsupportedEngine,

    /// Engine reported an error
    Engine(String),

    /// Configuration error
    Config(String),

    /// Storage/filesystem error
    Storage(String),

    /// Image pull/resolve error
    Image(String),

    /// Host-guest communication error
    Portal(String),

    /// Network error
    Network(String),

    /// gRPC error
    Rpc(String),

    /// gRPC transport error
    RpcTransport(String),

    /// Internal error
    Internal(String),

    /// Command run error
    Run(String),

    /// Unsupported operation
    Unsupported(String),

    /// Box not found
    NotFound(String),

    /// Resource already exists
    AlreadyExists(String),

    /// Invalid state for operation
    InvalidState(String),

    /// Database error
    Database(String),

    /// Metadata parsing error
    MetadataError(String),

    /// Invalid argument
    InvalidArgument(String),
}
```

### BoxliteResult

Result type alias for BoxLite operations.

```rust
pub type BoxliteResult<T> = Result<T, BoxliteError>;
```

#### Error Handling Example

```rust
use boxlite::BoxliteError;

match runtime.create(options, None).await {
    Ok(litebox) => println!("Created box: {}", litebox.id()),
    Err(BoxliteError::Image(msg)) => eprintln!("Image error: {}", msg),
    Err(BoxliteError::Config(msg)) => eprintln!("Config error: {}", msg),
    Err(e) => eprintln!("Other error: {}", e),
}
```

---

## Complete Example

```rust
use boxlite::runtime::{BoxliteRuntime, BoxOptions};
use boxlite::runtime::options::{AdvancedBoxOptions, RootfsSpec, SecurityOptions, VolumeSpec};
use boxlite::BoxCommand;
use futures::StreamExt;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize runtime
    let runtime = BoxliteRuntime::with_defaults()?;

    // Configure box
    let options = BoxOptions {
        cpus: Some(2),
        memory_mib: Some(1024),
        rootfs: RootfsSpec::Image("python:3.11-slim".to_string()),
        volumes: vec![
            VolumeSpec {
                host_path: "/home/user/code".to_string(),
                guest_path: "/app".to_string(),
                read_only: true,
            },
        ],
        advanced: AdvancedBoxOptions {
            security: SecurityOptions::standard(),
            ..Default::default()
        },
        ..Default::default()
    };

    // Create and name the box
    let litebox = runtime.create(options, Some("python-sandbox".to_string())).await?;
    println!("Created box: {}", litebox.id());

    // Run Python code
    let cmd = BoxCommand::new("python3")
        .args(["-c", "import sys; print(f'Python {sys.version}')"])
        .timeout(Duration::from_secs(30))
        .working_dir("/app");

    let mut run_handle = litebox.run(cmd).await?;

    // Stream output
    if let Some(mut stdout) = run_handle.stdout() {
        while let Some(line) = stdout.next().await {
            println!("{}", line);
        }
    }

    // Check result
    let result = run_handle.wait().await?;
    if !result.success() {
        eprintln!("Command failed with exit code: {}", result.exit_code);
    }

    // Check metrics
    let metrics = litebox.metrics().await?;
    if let Some(boot_ms) = metrics.guest_boot_duration_ms() {
        println!("Boot time: {}ms", boot_ms);
    }

    // Cleanup
    litebox.stop().await?;

    Ok(())
}
```

---

## Thread Safety

All public types are `Send + Sync`:

- `BoxliteRuntime` - safely shareable across threads
- `LiteBox` - safely shareable across threads
- `Execution` - Clone + shareable

```rust
use std::sync::Arc;
use tokio::task;

let runtime = Arc::new(BoxliteRuntime::with_defaults()?);

let handles: Vec<_> = (0..4).map(|i| {
    let rt = runtime.clone();
    task::spawn(async move {
        let box_opts = BoxOptions::default();
        let litebox = rt.create(box_opts, None).await?;
        // Each task has its own box
        Ok::<_, BoxliteError>(litebox.id().clone())
    })
}).collect();

for handle in handles {
    let id = handle.await??;
    println!("Created: {}", id);
}
```

---

## See Also

- [Getting Started Guide](../../getting-started/README.md)
- [Architecture Overview](../../architecture/README.md)
- [Configuration Reference](../README.md)
- [Python SDK Reference](../python/README.md)
- [Node.js SDK Reference](../nodejs/README.md)
