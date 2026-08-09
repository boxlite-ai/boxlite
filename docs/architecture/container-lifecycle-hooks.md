# Container Lifecycle Hook System

## Scope

Give BoxLite users the ability to inject custom logic at key points in the
container lifecycle — create, start, stop, exec, snapshot, restore — without
forking the runtime or wrapping every API call. Hooks run synchronously
(blocking) with configurable timeouts, ordered by user-defined priority. They
span the host (commands run on the host OS beside the runtime) and the guest
(commands run inside the container via exec).

This is an **embedded library feature** first — the Rust trait, CLI flags, and
SDK builders are the primary surface. The REST server inherits hooks from box
options supplied at creation and never invents its own. A hook's execution
location is determined by its action type: `HostExec` runs on the same machine
as the boxlite runtime; `GuestExec` runs inside the container via the Execution
RPC.

## Motivation

BoxLite's container lifecycle is opaque today. The runtime creates the VM,
creates the container, runs its init, and tears it down — all with no
user-visible interception points. For agent and CI workloads this means every
orchestrator wraps the runtime:

```
# Today: wrapping is external, fragile, and cannot act inside the container
boxlite run --name agent my-image
# ... agent installed deps, did work, exited
boxlite snapshot agent --name post-install   # missed the window
```

A hook system moves that logic *inside* the box definition, using
`$BOXLITE_*` variables to reference runtime context directly in command
arguments:

```
# With hooks: policy travels with the box
boxlite run --name agent my-image \
  --hook auto-init:post-start:guest:/opt/agent/register.sh \
  --hook-json '{
    "name":"auto-snapshot",
    "point":"post-exec",
    "action":{
      "type":"host-exec",
      "program":"boxlite",
      "args":["snapshot","$BOXLITE_BOX_ID","--name","latest"]
    },
    "condition":{"kind":"exec-result","trigger":"on-success"}
  }' \
  -- python agent.py
```

The target persona is the AI agent developer who needs:

1. **Auto-snapshot** after `pip install` / `npm install` completes — create a
   restore point the agent can rewind to. Requires filtering post-exec hooks to
   fire only on success, and optionally only when the exec command matches a
   pattern.
2. **Auto-init** on every start — run a bootstrap script before the main command
   to register the agent with a control plane.
3. **Pre-exit state save** — flush buffers and commit state before the container
   shuts down.
4. **Failure telemetry** — exec exits non-zero → POST to a webhook so the
   orchestrator can retry or escalate.

## Prior Art

BoxLite hooks draw from three established designs:

| System | Hook points | Execution model | Error semantics |
|--------|------------|-----------------|-----------------|
| **OCI Runtime Spec** | `prestart`, `poststart`, `poststop` | Exec on host; state JSON on stdin; blocking | Timeout → SIGKILL; non-zero → fail operation |
| **Kubernetes** | `PostStart` (concurrent with entrypoint), `PreStop` (before TERM) | Exec in container or HTTP GET; blocking for state transition | PostStart failure → kill container; PreStop → kill after grace |
| **systemd** | `ExecStartPre`, `ExecStartPost`, `ExecStopPost` | Exec on host; sequential, multiple; blocking | ExecStartPre failure → service failed; ExecStopPost always runs |

BoxLite combines them:

- **From OCI**: exec-on-host hooks with state JSON piped to stdin, timeout +
  forced kill, plus `$BOXLITE_*` variable substitution in command args so
  simple hooks don't need a wrapper script.
- **From Kubernetes**: guest-side exec (the "exec in container" handler type),
  PostStart/PreStop semantics.
- **From systemd**: multiple hooks per point, ordered execution, post hooks run
  regardless of the operation's outcome (where feasible).

## Hook Points

Every hook point is a named stage in the box or container lifecycle. Hooks are
registered per-box at creation time. Each hook point constrains which action
types are valid (see table below).

### Box lifecycle hooks

```
  Runtime.create()
       │
  ┌────▼──────┐
  │post-create│  host + trait hooks only (no VM yet; fires once, not on restart)
  └───────────┘
       │
  ┌────▼──────┐
  │ Configured│  (box exists, nothing running)
  └────┬──────┘
       │  start()
       │
  ┌────▼──────┐
  │ VM boots  │  (VmmSpawn → GuestConnect → GuestInit → ContainerInit)
  └────┬──────┘
       │
  ┌────▼─────┐
  │ pre-start │  host + trait hooks only (container created, init NOT running)
  └────┬─────┘
       │
  ┌────▼─────┐
  │  Start    │  (Container.Start → init runs)
  └────┬─────┘
       │
  ┌────▼─────┐
  │post-start │  host + guest + trait hooks (container init IS running)
  └────┬─────┘
       │
  ┌────▼─────┐
  │ Running   │  (exec, attach, copy)
  └────┬─────┘
       │  stop()
       │
  ┌────▼─────┐
  │ pre-stop  │  host + guest + trait hooks (container still alive)
  └────┬─────┘
       │
  ┌────▼─────┐
  │  Stop     │  (Guest.Shutdown → SIGTERM → wait → SIGKILL → shim exits)
  └────┬─────┘
       │
  ┌────▼─────┐
  │post-stop  │  host + trait hooks only (guest gone)
  └──────────┘
```

| Hook point | Fires | Valid action types | Error aborts operation? |
|-----------|-------|-------------------|------------------------|
| `post-create` | After first `Runtime.create()`, before it returns. Does **not** fire on restart/reattach | HostExec, trait | No (box is already created) |
| `pre-start` | After Container.Init, before `Container.Start` | HostExec, trait | Yes |
| `post-start` | After init starts, before `start()` returns | HostExec, GuestExec, trait | No (init already running) |
| `pre-stop` | Before `Guest.Shutdown` RPC | HostExec, GuestExec, trait | No (stop always proceeds) |
| `post-stop` | After shim exits, before state persisted | HostExec, trait | No (cleanup always finishes) |

### Execution lifecycle hooks

```
  ┌──────────┐
  │ pre-exec │  host + trait hooks only
  └────┬─────┘
       │
  ┌────▼─────┐
  │   Exec   │
  └────┬─────┘
       │
  ┌────▼─────┐
  │post-exec │  host + trait hooks only; fires on success AND failure
  └──────────┘
```

| Hook point | Fires | Valid action types | Error semantics |
|-----------|-------|-------------------|-----------------|
| `pre-exec` | Before `Exec` RPC | HostExec, trait | Yes (aborts exec) |
| `post-exec` | After `Wait` returns | HostExec, trait | No (exec already finished) |

`post-exec` carries the exit code in the hook context. Use the `condition` field
to restrict firing to success, failure, or specific exit codes — the hook runner
checks the condition before invoking the action, so non-matching hooks are
skipped entirely.

### Snapshot lifecycle hooks

```
  ┌──────────────┐
  │ pre-snapshot │  host + trait hooks (guest is up, filesystem writable)
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │   Quiesce    │
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │   Snapshot   │  (disk operation)
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │    Thaw      │
  └──────┬───────┘
         │
  ┌──────▼───────┐
  │post-snapshot │  host + trait hooks
  └──────────────┘
```

| Hook point | Fires | Valid action types | Error semantics |
|-----------|-------|-------------------|-----------------|
| `pre-snapshot` | Before quiesce (filesystems still writable) | HostExec, trait | Yes (aborts snapshot) |
| `post-snapshot` | After thaw | HostExec, trait | No |

Note: `pre-snapshot` fires **before** `Quiesce` so that host-exec hooks can
access container filesystems. If your hook needs the filesystem to be frozen,
it is not a good fit for this point — use a pre-stop hook before calling
snapshot instead.

### Restore lifecycle hooks

| Hook point | Fires | Valid action types | Error semantics |
|-----------|-------|-------------------|-----------------|
| `pre-restore` | Before loading snapshot | HostExec, trait | Yes (aborts restore) |
| `post-restore` | After VM boots from snapshot, before `start()` returns | HostExec, GuestExec, trait | No |

## Hook Definition

### Types

```rust
/// Where and how a hook executes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HookAction {
    /// Run a command on the host OS beside the runtime.
    ///
    /// Context is available in two forms:
    /// - Piped to the child's stdin as JSON (OCI convention).
    /// - Injected into `args` and `env` via literal `$BOXLITE_*` substitution
    ///   (see HookContext section for the full variable list).
    ///
    /// The child's stdout and stderr are captured and logged at INFO level
    /// (WARN on failure). The child runs in the runtime's process group;
    /// on timeout it receives SIGTERM, then SIGKILL after a 5 s grace.
    HostExec {
        program: String,
        /// Each element may contain `$BOXLITE_*` variables, which the runner
        /// replaces with their string values before spawning. No shell is
        /// involved — this is literal string substitution within each argv slot.
        args: Vec<String>,
        /// Extra environment variables (merged on top of the runtime's env).
        #[serde(default)]
        env: Vec<(String, String)>,
    },
    /// Run a command inside the container via the Execution RPC.
    ///
    /// Context is injected as environment variables (`BOXLITE_*`).
    /// `$BOXLITE_*` substitution in `args` and `env` is also performed.
    /// Stdout and stderr are captured and logged at DEBUG level (WARN on failure).
    /// Only valid at hook points where the container init is running
    /// (post-start, pre-stop, post-restore).
    GuestExec {
        command: String,
        args: Vec<String>,
        #[serde(default)]
        env: Vec<(String, String)>,
        /// User to run as inside the container (default: root).
        #[serde(default)]
        user: Option<String>,
        /// Working directory inside the container.
        #[serde(default)]
        working_dir: Option<String>,
    },
}

/// When a hook fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HookPoint {
    PostCreate,
    PreStart,
    PostStart,
    PreStop,
    PostStop,
    PreExec,
    PostExec,
    PreSnapshot,
    PostSnapshot,
    PreRestore,
    PostRestore,
}

/// Optional filter — the hook only fires when the condition matches.
///
/// `None` (the default) means the hook always fires at its point.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HookCondition {
    /// PostExec only: gate on the exec's exit code.
    ExecResult {
        trigger: ExecHookTrigger,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecHookTrigger {
    /// Fire regardless of exit code (equivalent to no condition).
    Always,
    /// Fire only when exit_code == 0.
    OnSuccess,
    /// Fire only when exit_code != 0.
    OnFailure,
    /// Fire only when exit_code equals this value.
    ExitCode(i32),
    /// Fire only when the exec command matches this glob pattern.
    /// Example: `"pip*"` matches `pip`, `pip3`, `pip install ...`.
    CommandMatches(String),
}

/// What to do when a hook's retries are exhausted.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnExhausted {
    /// Log the error and continue.
    #[default]
    Continue,
    /// Abort the triggering operation.
    Fail,
}

/// Error policy for a single hook.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HookErrorPolicy {
    /// Log the error and continue (default for post- hooks and pre-stop).
    #[default]
    Continue,
    /// Abort the triggering operation (default for pre- hooks except pre-stop).
    Fail,
    /// Retry up to N times with linear backoff, then apply `on_exhausted`.
    Retry {
        max_retries: u32,
        backoff_secs: u64,
        #[serde(default)]
        on_exhausted: OnExhausted,
    },
}

/// A single hook registered on a box.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    /// Human-readable name for debugging and logs. Must be unique within a box.
    pub name: String,
    /// When this hook fires.
    pub point: HookPoint,
    /// What this hook does.
    pub action: HookAction,
    /// Whether the hook is active. Set to `false` to temporarily disable it
    /// without removing it from the configuration.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Lower-numbered hooks run first. Default 0.
    #[serde(default)]
    pub priority: i32,
    /// Timeout in seconds. The default is 30 s. Must be ≥ 1.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// Only fire when this condition holds. `None` = always fire.
    #[serde(default)]
    pub condition: Option<HookCondition>,
    /// What to do when this hook fails (non-zero exit, timeout, or spawn error).
    #[serde(default)]
    pub on_error: HookErrorPolicy,
}

fn default_enabled() -> bool { true }
fn default_timeout() -> u64 { 30 }
```

### HookContext — data passed to every hook

```rust
/// Context passed to every hook at fire time.
///
/// For HostExec hooks this is serialized to JSON and piped to the child's stdin.
/// Additionally, `$BOXLITE_*` variables in `args` and `env` are replaced before
/// spawn (see variable list below).
///
/// For GuestExec hooks each field is exported as a `BOXLITE_<KEY>` env var.
///
/// For `Hook` trait implementations this is the `ctx` argument.
#[derive(Debug, Clone, Serialize)]
pub struct HookContext {
    /// Box ID (e.g. "bxp8k2m1...").
    pub box_id: String,
    /// Container ID (64-char hex).
    pub container_id: String,
    /// Which hook point is firing.
    pub hook_point: HookPoint,
    /// Name of this specific hook.
    pub hook_name: String,
    /// Current box status.
    pub box_status: BoxStatus,
    /// Image reference (e.g. "python:3.12").
    pub image: String,
    /// How many times this hook has fired in this box's lifetime.
    /// Persisted in the box state database keyed by `(box_id, hook_name)`.
    /// Survives runtime restarts for declarative hooks; resets to 1 on each
    /// re-registration for trait hooks.
    pub fire_count: u64,

    // ── Exec-specific (only populated for pre-exec / post-exec) ──
    /// Exit code. `None` for pre-exec; the actual code for post-exec.
    pub exit_code: Option<i32>,
    /// The exec command (argv). `None` for non-exec points.
    pub exec_command: Option<Vec<String>>,
    /// Wall-clock duration in ms. `None` for pre-exec.
    pub exec_duration_ms: Option<u64>,

    // ── Snapshot-specific (only populated for snapshot points) ──
    /// Name of the snapshot being created or restored.
    pub snapshot_name: Option<String>,
}
```

### `$BOXLITE_*` variable substitution

For both `HostExec` and `GuestExec` actions, the hook runner performs literal
string substitution on every element of `args` and every value in `env` **before**
spawning. No shell is invoked — each `$BOXLITE_VAR` token is replaced with its
string value from the `HookContext`. This means users can write:

```rust
HookAction::HostExec {
    program: "boxlite".into(),
    args: vec![
        "snapshot".into(),
        "$BOXLITE_BOX_ID".into(),       // ← resolved at fire time
        "--name".into(),
        "post-install".into(),
    ],
    env: vec![
        ("ALERT_BOX".into(), "$BOXLITE_BOX_ID".into()),
        ("ALERT_CODE".into(), "$BOXLITE_EXIT_CODE".into()),
    ],
}
```

Variables available for substitution:

| Variable | Source field | Example value | Notes |
|----------|-------------|---------------|-------|
| `$BOXLITE_BOX_ID` | `box_id` | `bxp8k2m1abc...` | Always set |
| `$BOXLITE_CONTAINER_ID` | `container_id` | `a1b2c3d4...` | Always set |
| `$BOXLITE_HOOK_POINT` | `hook_point` | `post-exec` | Always set |
| `$BOXLITE_HOOK_NAME` | `hook_name` | `auto-snapshot` | Always set |
| `$BOXLITE_BOX_STATUS` | `box_status` | `running` | Always set |
| `$BOXLITE_IMAGE` | `image` | `python:3.12` | Always set |
| `$BOXLITE_FIRE_COUNT` | `fire_count` | `5` | Always set |
| `$BOXLITE_EXIT_CODE` | `exit_code` | `0` | Empty string for non-exec points |
| `$BOXLITE_EXEC_COMMAND` | `exec_command` | `pip install -r ...` | JSON-joined with spaces; empty for non-exec |
| `$BOXLITE_EXEC_DURATION_MS` | `exec_duration_ms` | `4200` | Empty string for pre-exec |
| `$BOXLITE_SNAPSHOT_NAME` | `snapshot_name` | `post-install` | Empty for non-snapshot points |

Unrecognized `$BOXLITE_*` tokens are left as-is (no error) so that literal
`$BOXLITE_FOO` in an arg stays literal.

**Important**: Substitution is raw string replacement. Values are **not** escaped
for JSON, HTML, SQL, or any other context. If you embed a `$BOXLITE_*` variable
inside a JSON string argument (e.g., `curl -d '{"box":"$BOXLITE_BOX_ID"}'`),
ensure the value cannot contain `"` or `\`, or use a wrapper script that reads
the full context from stdin and performs proper encoding. In practice box IDs,
container IDs, and image names are hex or alphanumeric and safe for JSON;
`$BOXLITE_EXEC_COMMAND` may contain arbitrary characters from user input.

The full JSON is still piped to stdin for `HostExec` — scripts that need
structured data (nested fields, arrays) or that don't want to parse argv can
read stdin instead. The substitution is a convenience for the 90% case.

Host-exec hooks receive this as JSON on stdin:

```json
{
  "box_id": "bxp8k2m...",
  "container_id": "a1b2c3...",
  "hook_point": "post-exec",
  "hook_name": "auto-snapshot",
  "box_status": "running",
  "image": "python:3.12",
  "fire_count": 5,
  "exit_code": 0,
  "exec_command": ["pip", "install", "-r", "requirements.txt"],
  "exec_duration_ms": 4200,
  "snapshot_name": null
}
```

Guest-exec hooks receive the same data as environment variables:

```text
BOXLITE_BOX_ID=bxp8k2m...
BOXLITE_CONTAINER_ID=a1b2c3...
BOXLITE_HOOK_POINT=post-start
BOXLITE_HOOK_NAME=auto-init
BOXLITE_BOX_STATUS=running
BOXLITE_IMAGE=python:3.12
BOXLITE_FIRE_COUNT=3
BOXLITE_EXIT_CODE=        # empty for non-exec points
BOXLITE_EXEC_COMMAND=     # empty for non-exec points
BOXLITE_EXEC_DURATION_MS= # empty for non-exec points
BOXLITE_SNAPSHOT_NAME=    # empty for non-snapshot points
```

### Default on_error per hook point

| Hook point | Default `on_error` | Rationale |
|-----------|-------------------|-----------|
| `post-create` | `Continue` | Box already created; hook failure shouldn't roll it back |
| `pre-start` | `Fail` | Guard the start with preconditions |
| `post-start` | `Continue` | Init is already running; hook failure shouldn't kill it |
| `pre-stop` | `Continue` | Stop must always proceed (systemd ExecStopPost semantics) |
| `post-stop` | `Continue` | Cleanup always finishes |
| `pre-exec` | `Fail` | Guard exec with preconditions |
| `post-exec` | `Continue` | Exec already finished; hook is a side effect |
| `pre-snapshot` | `Fail` | Guard snapshot with preconditions |
| `post-snapshot` | `Continue` | Snapshot already taken |
| `pre-restore` | `Fail` | Guard restore with preconditions |
| `post-restore` | `Continue` | Restore already complete |

## Configuration

### Rust SDK

```rust
use boxlite::hooks::{
    Hook, HookPoint, HookAction, HookCondition,
    ExecHookTrigger, HookErrorPolicy,
};

let hooks = vec![
    // 1. Bootstrap on every start
    Hook {
        name: "agent-bootstrap".into(),
        point: HookPoint::PostStart,
        action: HookAction::GuestExec {
            command: "/opt/agent/register.sh".into(),
            args: vec![],
            env: vec![(
                "AGENT_TOKEN".into(),
                std::env::var("AGENT_TOKEN").unwrap_or_default(),
            )],
            user: Some("agent".into()),
            working_dir: Some("/opt/agent".into()),
        },
        enabled: true,
        priority: 0,
        timeout_secs: 30,
        condition: None,
        on_error: HookErrorPolicy::Fail,
    },
    // 2. Snapshot after successful pip install
    Hook {
        name: "post-install-snapshot".into(),
        point: HookPoint::PostExec,
        action: HookAction::HostExec {
            program: "boxlite".into(),
            args: vec![
                "snapshot".into(),
                "$BOXLITE_BOX_ID".into(),
                "--name".into(),
                "post-install".into(),
            ],
            env: vec![],
        },
        enabled: true,
        priority: 10,
        timeout_secs: 60,
        condition: Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::CommandMatches("pip*".into()),
        }),
        on_error: HookErrorPolicy::Continue,
    },
];

let opts = BoxOptions::new("python:3.12")
    .hooks(hooks)
    .cmd(vec!["python".into(), "agent.py".into()]);

let rt = BoxliteRuntime::new().await?;
let bx = rt.create(opts).await?;
bx.start().await?;
```

### CLI

Two forms are supported. The simple form covers common cases:

```text
--hook <name>:<point>:<host|guest>:<program> [--hook-arg <arg>]...
```

Per-hook modifiers:

| Flag | Example |
|------|---------|
| `--hook-enabled <name>=true\|false` | Disable without removing |
| `--hook-priority <name>=<int>` | Execution order |
| `--hook-timeout <name>=<seconds>` | Per-hook timeout |
| `--hook-on-error <name>=fail\|continue\|retry:<N>,<backoff_s>` | Error policy |
| `--hook-condition-exec-result <name>=always\|success\|failure\|exit:<code>\|cmd:<glob>` | PostExec filter |
| `--hook-env <name>=<KEY=VALUE>` | Extra env vars |
| `--hook-user <name>=<user>` | GuestExec user |
| `--hook-workdir <name>=<path>` | GuestExec working dir |

For programmatic use with all options, use JSON:

```text
--hook-json '<json>'
```

**Examples:**

```text
# Simple: bootstrap after every start
boxlite run python:3.12 \
  --hook agent-bootstrap:post-start:guest:/opt/agent/register.sh \
  --hook-on-error agent-bootstrap=fail \
  --hook-timeout agent-bootstrap=10 \
  -- python agent.py

# Post-exec snapshot after pip install (uses $BOXLITE_BOX_ID substitution)
boxlite run python:3.12 \
  --hook post-install-snapshot:post-exec:host:boxlite \
  --hook-arg snapshot \
  --hook-arg '$BOXLITE_BOX_ID' \
  --hook-arg --name \
  --hook-arg post-install \
  --hook-condition-exec-result post-install-snapshot=cmd:pip* \
  -- python agent.py

# Full control with JSON — $BOXLITE_* vars work in args
boxlite run python:3.12 \
  --hook-json '{
    "name":"auto-snapshot",
    "point":"post-exec",
    "action":{
      "type":"host-exec",
      "program":"boxlite",
      "args":["snapshot","$BOXLITE_BOX_ID","--name","latest"]
    },
    "condition":{"kind":"exec-result","trigger":"on-success"},
    "timeout_secs":60,
    "priority":10
  }' \
  -- python agent.py
```

### JSON / REST API

```json
{
  "image": "python:3.12",
  "cmd": ["python", "agent.py"],
  "hooks": [
    {
      "name": "agent-bootstrap",
      "point": "post-start",
      "action": {
        "type": "guest-exec",
        "command": "/opt/agent/register.sh",
        "args": [],
        "env": [],
        "user": "agent",
        "working_dir": "/opt/agent"
      },
      "enabled": true,
      "priority": 0,
      "timeout_secs": 30,
      "condition": null,
      "on_error": "fail"
    },
    {
      "name": "post-install-snapshot",
      "point": "post-exec",
      "action": {
        "type": "host-exec",
        "program": "boxlite",
        "args": ["snapshot", "$BOXLITE_BOX_ID", "--name", "post-install"]
      },
      "enabled": true,
      "priority": 10,
      "timeout_secs": 60,
      "condition": {
        "kind": "exec-result",
        "trigger": "on-success"
      },
      "on_error": "continue"
    }
  ]
}
```

**REST runtimes**: `HostExec` hooks on a remote box execute on the **runner**
machine (where the boxlite runtime lives), **not** on the API client. This is
by design — the hook runs beside the VM it manages. REST clients that need
client-side hooks should register them via the SDK on the runner side, or use
webhooks triggered from within a GuestExec hook.

### In-process trait (Rust embedders)

For Rust users who want hooks that share address space with the runtime (no
subprocess, no serialization overhead):

```rust
/// In-process hook interface.
///
/// All methods default to no-op. Implement only the points you need.
/// These run on the box's async runtime — do not block for extended periods.
///
/// # Differences from declarative hooks
///
/// Trait hooks have no timeout or error-policy enforcement — the runtime trusts
/// the implementation to be well-behaved. Returning `Err(...)` from a trait
/// method aborts the triggering operation when the hook point's error semantics
/// say "yes" (see the hook-point table above); for post- hooks, errors are
/// logged and discarded.
///
/// Trait hooks are **not persisted** across restarts. After a runtime restart,
/// the application must re-register its trait implementations. Declarative
/// hooks (from `BoxOptions.hooks`) survive restarts because they are stored in
/// the box database.
pub trait Hook: Send + Sync {
    /// Return the hook point(s) this implementation handles.
    fn points(&self) -> Vec<HookPoint> { vec![] }

    /// Priority for ordering. Lower = runs first. Default 0.
    fn priority(&self) -> i32 { 0 }

    async fn on_post_create(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_pre_start(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_post_start(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_pre_stop(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_post_stop(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_pre_exec(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_post_exec(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_pre_snapshot(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_post_snapshot(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_pre_restore(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
    async fn on_post_restore(&self, _ctx: &HookContext) -> BoxliteResult<()> { Ok(()) }
}
```

The `EventListener` trait is **not** removed — it remains the push-based
notification callback for observability (metrics, audit logging). `Hook` is a
new, separate trait because its semantics differ:
- Hooks are **blocking** (operation waits for them).
- Hooks can **abort** the triggering operation (via `Err` return for pre- hooks).
- Declarative hooks have **timeouts** and **retry** policies.
- EventListeners are fire-and-forget observers.

## Architecture

### Hook registry and dispatch

```
BoxOptions.hooks: Vec<Hook>                     ← declarative, serializable
       │
       ▼
BoxImpl.trait_hooks: Vec<Arc<dyn Hook>>          ← in-process (not persisted)
BoxImpl.declarative_hooks: Vec<Hook>             ← from BoxOptions
       │
       ▼
BoxImpl.hook_runner: HookRunner                  ← merged registry, created once
       │
       ├─ start()
       │    ├─ runner.fire(PreStart, ctx, guest=None)    ← GuestExec not valid here
       │    ├─ Container.Start RPC
       │    └─ runner.fire(PostStart, ctx, guest=Some(&session))
       │
       ├─ stop()
       │    ├─ runner.fire(PreStop, ctx, guest=Some(&session))
       │    ├─ Guest.Shutdown RPC
       │    └─ runner.fire(PostStop, ctx, guest=None)    ← guest is gone
       │
       ├─ exec()
       │    ├─ runner.fire(PreExec, ctx, guest=None)
       │    ├─ Exec RPC + Wait
       │    └─ runner.fire(PostExec, ctx, guest=None)
       │
       └─ snapshot()
            ├─ runner.fire(PreSnapshot, ctx, guest=None) ← before quiesce
            ├─ Quiesce
            ├─ snapshot disk
            ├─ Thaw
            └─ runner.fire(PostSnapshot, ctx, guest=None)
```

### Hook runner

```rust
/// Owns the merged hook registry and executes hooks on demand.
///
/// Created once per `BoxImpl` and reused across all hook points.
struct HookRunner {
    trait_hooks: Vec<Arc<dyn Hook>>,
    declarative_hooks: Vec<Hook>,
}

impl HookRunner {
    /// Fire all hooks registered for `point`.
    ///
    /// `guest` is required for hook points that allow `GuestExec`
    /// (post-start, pre-stop, post-restore). Callers at points where
    /// GuestExec is invalid (post-create, pre-start, post-stop,
    /// pre-exec, post-exec, pre-snapshot, post-snapshot, pre-restore)
    /// pass `None`.
    async fn fire(
        &self,
        point: HookPoint,
        ctx: &HookContext,
        guest: Option<&GuestSession>,
    ) -> BoxliteResult<()> { ... }
}
```

Internal logic of `fire()`:

```
fire(point, ctx, guest)
  │
  ├─ 1. Collect hooks matching `point` from both sources:
  │      - trait impls whose `points()` includes this point
  │      - declarative hooks with `point == point` AND `enabled == true`
  │
  ├─ 2. Sort by priority (ascending). Equal priorities:
  │      trait hooks run before declarative hooks; within each group,
  │      registration order.
  │
  ├─ 3. For each hook in order:
  │      │
  │      ├─ Check condition (for declarative hooks):
  │      │    condition is None → proceed
  │      │    condition is ExecResult { trigger: Always } → proceed
  │      │    condition is ExecResult { trigger: OnSuccess } ∧ exit_code != 0 → skip
  │      │    condition is ExecResult { trigger: OnFailure } ∧ exit_code == 0 → skip
  │      │    condition is ExecResult { trigger: ExitCode(n) } ∧ exit_code != n → skip
  │      │    condition is ExecResult { trigger: CommandMatches(glob) } ∧ no match → skip
  │      │
  │      ├─ Perform $BOXLITE_* substitution in args and env (HostExec + GuestExec).
  │      │
  │      ├─ Select strategy:
  │      │    HostExec  → tokio::process::Command, pipe ctx as JSON to stdin.
  │      │                Capture stdout+stderr → tracing::info!(hook_output).
  │      │                On failure → tracing::warn!(hook_output).
  │      │    GuestExec → if guest is None → skip (misconfigured hook:
  │      │                GuestExec at a point with no guest session).
  │      │                Otherwise → guest.execution().exec(command).wait().
  │      │                Capture stdout+stderr → tracing::debug!(hook_output).
  │      │                On failure → tracing::warn!(hook_output).
  │      │    Trait     → hook.on_<point>(ctx).await (no timeout enforcement).
  │      │
  │      ├─ For HostExec/GuestExec: apply timeout
  │      │    tokio::time::timeout(hook.timeout_secs, fut).await
  │      │    On timeout → SIGTERM → 5 s grace → SIGKILL (HostExec)
  │      │                 or Execution.Kill(SIGKILL) (GuestExec)
  │      │
  │      └─ Evaluate result:
  │           ├─ Ok(exit_status) where exit_status.success() → next hook
  │           ├─ Ok(exit_status) where !exit_status.success() →
  │           │    match hook.on_error:
  │           │      Continue → log warn, next hook
  │           │      Fail → return error (abort operation)
  │           │      Retry { n, backoff, on_exhausted } → retry loop →
  │           │        maxed out → apply on_exhausted
  │           └─ Err(timeout | spawn | RPC error) →
  │                same on_error dispatch as non-zero exit
  │
  └─ 4. Return Ok(()) or first Fail error
```

Each `fire()` call runs its hooks sequentially, but **separate operations on
the same box are not serialized**: two concurrent `exec()` calls each run their
own `fire(PostExec)` independently. Hook authors are responsible for ensuring
their hook actions are safe under concurrent execution (e.g., `boxlite snapshot`
already serializes via the quiesce lock, so two concurrent snapshot hooks will
not corrupt state — the second will wait or fail).

### Tracing

Every hook execution is wrapped in a tracing span with:

```rust
tracing::info_span!(
    "hook",
    box.id = %ctx.box_id,
    hook.name = %hook.name,
    hook.point = %ctx.hook_point,
    hook.fire_count = ctx.fire_count,
)
```

This ensures all hook stdout/stderr and error messages are correlated to the
box and hook that produced them.

### Integration points in the current codebase

```
src/boxlite/src/runtime/rt_impl.rs
  create_box()  ← fire PostCreate after BoxImpl::new returns
                   (NOT in BoxImpl::new — that is also called on DB reload)

src/boxlite/src/litebox/box_impl.rs
  start()   ← fire PreStart before ensure_container_started
            ← fire PostStart after on_box_started listeners
  stop()    ← fire PreStop before guest.shutdown()
            ← fire PostStop after handler.stop(), before persist
  exec()    ← fire PreExec after ensure_usable, before ExecutionInterface::exec
            ← fire PostExec after Wait returns

src/boxlite/src/litebox/snapshot.rs
  create()  ← fire PreSnapshot before quiesce
            ← fire PostSnapshot after thaw

src/boxlite/src/hooks/                    (new module)
  mod.rs        — Hook, HookPoint, HookAction, HookCondition, HookContext,
                  ExecHookTrigger, HookErrorPolicy, OnExhausted, HookRunner
  runner.rs     — HookRunner::fire(), collect, sort, $BOXLITE_* substitution,
                  condition eval, timeout, retry loop, error dispatch
  host_exec.rs  — HostExec: Command spawn + stdin pipe + timeout + kill +
                  stdout/stderr capture
  guest_exec.rs — GuestExec: guest_session.exec() + Wait + stdout/stderr capture
  context.rs    — HookContext serialization (JSON for host, env-vars for guest)
  registry.rs   — merged sorted view of trait impls + declarative hooks
  fire_count.rs — per-(box, hook_name) counter persisted in box state DB

src/boxlite/src/runtime/options.rs
  BoxOptions.hooks: Vec<Hook>   ← new field

src/shared/proto/boxlite/v1/service.proto
  (no changes — GuestExec hooks reuse the existing Execution service)

src/cli/
  --hook, --hook-json, --hook-arg, --hook-enabled, --hook-priority,
  --hook-timeout, --hook-on-error, --hook-condition-exec-result,
  --hook-env, --hook-user, --hook-workdir
```

## Error Handling & Semantics

### Pre- hooks vs Post- hooks

| Aspect | Pre- hooks (except pre-stop) | pre-stop + all Post- hooks |
|--------|------------------------------|---------------------------|
| Default `on_error` | `Fail` | `Continue` |
| On timeout | Operation aborted | Warning logged |
| On non-zero exit | Operation aborted | Warning logged |
| Ordering guarantee | All run in priority order before the operation | Hook N+1 runs even if hook N failed (with Continue) |
| Partial failure | First failure stops the chain | Each hook runs independently |

### Idempotency

Hooks carry no built-in idempotency guarantee. If a `post-exec` hook fires
twice (e.g., the box is stopped and restarted), the hook runs twice. Hook
authors are responsible for making their hooks idempotent where double-firing
matters. The `HookContext.fire_count` field tracks how many times this hook
has fired; scripts can use it to skip repeated work:

```sh
#!/bin/sh
# Only run on first boot
[ "$BOXLITE_FIRE_COUNT" -gt 1 ] && exit 0
apt-get update && apt-get install -y build-essential
```

### Timeout and forced kill

1. Hook starts, timeout timer begins.
2. If the hook hasn't completed by `timeout_secs`:
   - `HostExec`: SIGTERM → 5 s grace → SIGKILL the child process group.
   - `GuestExec`: `Execution.Kill` RPC with SIGKILL.
3. The timeout error is treated as any other failure: `on_error` policy applies.

### Concurrency

Within a single `fire()` call, hooks execute sequentially in priority order.
However, **separate operations on the same box are NOT serialized**:

- Two concurrent `exec()` calls each run their own `fire(PostExec)`. If both
  hooks call `boxlite snapshot`, the second will encounter the quiesce lock
  held by the first and either wait or fail (depending on the snapshot
  implementation's locking strategy).
- Hook actions that mutate shared state should be internally synchronized.
  BoxLite's own operations (`snapshot`, `stop`) already use per-box locks;
  custom HostExec commands that touch the box's filesystem should use `flock`
  or similar.

### Trait hooks after runtime restart

Declarative hooks (`Hook` structs in `BoxOptions`) are serialized to the box
database and survive runtime restarts. Trait hooks (`Arc<dyn Hook>`) are
registered in memory at runtime; after a restart the application must
re-register them. The `fire_count` for declarative hooks is persisted in the
box state database keyed by `(box_id, hook_name)`; for trait hooks it resets
to 1 on each registration.

### No automatic rollback

If a `pre-start` chain has multiple hooks and hook B fails after hook A
succeeded, hook A's side effects are not rolled back. The operation is aborted
but the state is whatever hook A left behind. This matches the OCI and systemd
semantics (neither provides distributed-transaction rollback). Users who need
atomicity should consolidate multi-step setup into a single hook, or implement
their own compensation logic in an `on_error` script.

## Examples — Agent Scenarios

### 1. Auto-snapshot after dependency installation (filtered)

```rust
// After `pip install` succeeds, snapshot the box.
// Uses $BOXLITE_BOX_ID so we don't need a wrapper script.
let hooks = vec![
    Hook {
        name: "post-install-snapshot".into(),
        point: HookPoint::PostExec,
        action: HookAction::HostExec {
            program: "boxlite".into(),
            args: vec![
                "snapshot".into(),
                "$BOXLITE_BOX_ID".into(),
                "--name".into(),
                "post-install".into(),
            ],
            env: vec![],
        },
        enabled: true,
        priority: 10,
        timeout_secs: 120,
        condition: Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::CommandMatches("pip*".into()),
        }),
        on_error: HookErrorPolicy::Continue,
    },
];
```

For hooks that need structured context (not just substituted variables), a
wrapper script reading stdin JSON is still supported:

```sh
#!/bin/sh
# Reads HookContext from stdin
CTX=$(cat)
BOX_ID=$(echo "$CTX" | jq -r '.box_id')
EXIT_CODE=$(echo "$CTX" | jq -r '.exit_code')
CMD=$(echo "$CTX" | jq -r '.exec_command | join(" ")')

[ "$EXIT_CODE" != "0" ] && exit 0
boxlite snapshot "$BOX_ID" --name "post-$(echo "$CMD" | sha256sum | head -c 8)"
```

### 2. Bootstrap script on every start

```rust
let hooks = vec![
    Hook {
        name: "agent-bootstrap".into(),
        point: HookPoint::PostStart,
        action: HookAction::GuestExec {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "/opt/agent/register.sh".into()],
            env: vec![(
                "AGENT_TOKEN".into(),
                std::env::var("AGENT_TOKEN").unwrap_or_default(),
            )],
            user: Some("agent".into()),
            working_dir: Some("/opt/agent".into()),
        },
        enabled: true,
        priority: 0,
        timeout_secs: 30,
        condition: None,
        on_error: HookErrorPolicy::Fail,  // Don't start if we can't register
    },
];
```

### 3. Pre-exit state save

```rust
let hooks = vec![
    Hook {
        name: "save-state".into(),
        point: HookPoint::PreStop,
        action: HookAction::GuestExec {
            command: "/opt/agent/save.sh".into(),
            args: vec![],
            env: vec![],
            user: Some("agent".into()),
            working_dir: Some("/opt/agent/state".into()),
        },
        enabled: true,
        priority: 100,  // Run last among pre-stop hooks
        timeout_secs: 15,
        condition: None,
        on_error: HookErrorPolicy::Continue,  // Don't block shutdown
    },
];
```

### 4. Failure notification with retry

```rust
let hooks = vec![
    Hook {
        name: "notify-failure".into(),
        point: HookPoint::PostExec,
        action: HookAction::HostExec {
            program: "curl".into(),
            args: vec![
                "-X".into(), "POST".into(),
                "-H".into(), "Content-Type: application/json".into(),
                "-d".into(),
                // $BOXLITE_* substitution fills in the values
                r#"{"box":"$BOXLITE_BOX_ID","code":$BOXLITE_EXIT_CODE}"#.into(),
                "https://hooks.example.com/agent-alert".into(),
            ],
            env: vec![],
        },
        enabled: true,
        priority: 0,
        timeout_secs: 10,
        condition: Some(HookCondition::ExecResult {
            trigger: ExecHookTrigger::OnFailure,
        }),
        on_error: HookErrorPolicy::Retry {
            max_retries: 3,
            backoff_secs: 2,
            on_exhausted: OnExhausted::Continue,
        },
    },
];
```

## Implementation Plan

### Phase 1 — Core infrastructure (host-exec, in-process trait)

1. Add `src/boxlite/src/hooks/` module with types, runner, host-exec strategy.
2. Add `hooks: Vec<Hook>` field to `BoxOptions`.
3. Wire `fire()` calls into `RuntimeImpl::create_box()` (PostCreate) and
   `BoxImpl::{start, stop, exec}` (all other points).
4. Implement `$BOXLITE_*` variable substitution in the runner.
5. Add `Hook` trait for in-process Rust embedders.
6. Add fire-count persistence in the box state database.
7. Add CLI flags.
8. Unit tests for runner (ordering, timeout, retry, error policies, condition
   evaluation, variable substitution, enabled flag).

### Phase 2 — Guest-exec hooks

1. Implement `GuestExec` strategy via the Execution RPC.
2. Integration tests with real boxes.

### Phase 3 — Snapshot and restore hooks

1. Wire `PreSnapshot` / `PostSnapshot` into snapshot operations.
2. Wire `PreRestore` / `PostRestore` into restore operations.

### Phase 4 — SDK surfaces

1. Python SDK: `Hook` dataclass + `BoxOptions.hooks` list.
2. Node SDK: `Hook` interface + `BoxOptions.hooks` array.
3. Go SDK: `Hook` struct + `BoxOptions.Hooks` slice.
4. C SDK: `boxlite_hook_t` struct + `boxlite_options_add_hook()`.
5. REST API: hooks in create-box JSON body, returned in get-box response.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Hook hangs indefinitely | Mandatory timeout per hook; forced kill on expiry |
| Hook fails after operation completes (post- hooks) | `on_error: Continue` by default for all post- hooks |
| Guest-exec hook fails because container is unhealthy | Timeout + Continue policy; hook context carries container status |
| Hooks slow down `start()` / `exec()` | Timeout per hook; users keep hooks lightweight; post hooks run after operation is semantically complete |
| Hook command injection via untrusted input | HostExec runs the exact argv provided (no shell). GuestExec uses the Execution RPC (no shell). CLI `--hook` uses `--hook-arg` for each argument — no shell splitting. `$BOXLITE_*` substitution is literal string replacement, not shell expansion |
| Hook ordering surprises | Priority is explicit; equal priorities run trait-before-declarative, then registration order. Fully documented |
| Trait hooks lost on runtime restart | Documented constraint. Declarative hooks (in `BoxOptions`) survive restarts. Applications using trait hooks must re-register after a restart |
| `HostExec` on a remote box runs on the runner, not the client | Documented in the REST API section. Clients needing client-side side effects should use webhooks triggered from within a GuestExec hook |
| `pre-snapshot` host-exec hooks modifying filesystem during quiesce | `PreSnapshot` fires **before** quiesce; filesystems are still writable at hook time |
| Concurrent hook execution racing on shared box state | Per-box operations (`snapshot`, `stop`) already hold internal locks. Custom hooks that mutate the same resource must bring their own synchronization |
| HostExec hook calling `boxlite` CLI in embedded mode (no daemon) | The CLI process starts its own runtime instance and cannot see the in-process box. In embedded mode, use a `Hook` trait implementation to call the runtime API directly; in daemon mode (`boxlite serve`), the CLI connects via the control socket. Document this in the CLI help and SDK guides |
| `post-create` firing on DB reload after restart | The fire call is placed in `RuntimeImpl::create_box()`, not `BoxImpl::new()`. `create_box` is only called for fresh creations; `load_box` (used for restart/reattach) does not trigger it |
