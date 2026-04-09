# Box Restart Policies

BoxLite supports multiple restart policies for automatic recovery when a Box (VM) crashes. This document details the architecture, inner workings, and configuration of the restart mechanism.

---

## Part 1: Architecture Overview

### 1.1 Three Layers of Restart Mechanisms

BoxLite's restart system operates at **three layers**, triggered in different scenarios:

| Layer | Trigger | Handler | Characteristics |
|-------|---------|---------|-----------------|
| **Runtime-time** | VM crashes while user process is running | Health Check + Crash Handler | Real-time detection, millisecond response |
| **Startup-time** | User restarts process, calls `Runtime::new()` | `recover_boxes()` | Recovery detection, state evaluation is synchronous; auto-restarts are async |
| **Manual** | User calls `start()` on stopped box | `start()` → `restart()` (internal) | Immediate execution, bypasses policy |

**Key Insight**:
- BoxLite is an **embedded library** without a background daemon
- Health Check runs **in-process** and stops when the process exits
- Startup recovery handles crashes that occurred while the process was down

### 1.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           BoxLite Runtime (Host Process)                        │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      Crash Handler Task (per Runtime)                   │    │
│  │                                                                         │    │
│  │   ┌─────────────┐     ┌──────────────┐     ┌──────────────────────┐     │    │
│  │   │ mpsc::      │────▶│ Process      │────▶│ Evaluate Restart     │     │    │
│  │   │ Receiver    │     │ Crash Event  │     │ Policy               │     │    │
│  │   └─────────────┘     └──────────────┘     └──────────────────────┘     │    │
│  │        │                                            │                   │    │
│  │        │                                    ┌───────┴──────┐            │    │
│  │        │                                    ▼              ▼            │    │
│  │        │                              ┌─────────┐   ┌──────────┐        │    │
│  │        │                              │ No      │   │ Yes      │        │    │
│  │        │                              │ Restart │   │ Restart  │        │    │
│  │        │                              └────┬────┘   └────┬─────┘        │    │
│  │        │                                   │             │              │    │
│  │        │                                   ▼             ▼              │    │
│  │        │                             ┌──────────┐   ┌──────────────┐    │    │
│  │        │                             │ Mark     │   │ Backoff +    │    │    │
│  │        │                             │ Stopped  │   │ Call restart │    │    │
│  │        │                             └──────────┘   └──────────────┘    │    │
│  │        │                                                                │    │
│  │   ┌────┴────┐  ┌────────────────────────────────────────────────────┐   │    │
│  │   │Shutdown │◀─┤ Listens to:                                        │   │    │
│  │   │ Token   │  │  - crash_rx.recv()                                 │   │    │
│  │   └─────────┘  │  - shutdown_token.cancelled()                      │   │    │
│  │                └────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                    │                                            │
│                                    │ mpsc::channel<BoxID>                       │
│                                    ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                           BoxImpl (per Box)                             │    │
│  │                                                                         │    │
│  │   ┌────────────────────────────────────────────────────────────────┐    │    │
│  │   │                    Health Check Task                           │    │    │
│  │   │                                                                │    │    │
│  │   │   loop {                                                       │    │    │
│  │   │       tokio::select! {                                         │    │    │
│  │   │           _ = sleep(interval) => {                             │    │    │
│  │   │               match guest.ping().await {                       │    │    │
│  │   │                   Ok(_) => mark_healthy(),                     │    │    │
│  │   │                   Err(_) => {                                  │    │    │
│  │   │                       if !is_shim_alive() {                    │    │    │
│  │   │                           crash_tx.send(box_id); ─────────┐    │    │    │
│  │   │                           break; // Task exits ───────────┤    │    │    │
│  │   │                       }                                   │    │    │    │
│  │   │                       if retries_exceeded() {             │    │    │    │
│  │   │                           mark_unhealthy();               │    │    │    │
│  │   │                           break;                          │    │    │    │
│  │   │                       }                                   │    │    │    │
│  │   │                   }                                       │    │    │    │
│  │   │               }                                           │    │    │    │
│  │   │           }                                               │    │    │    │
│  │   │           _ = shutdown_token.cancelled() => break; ◀──────┘    │    │    │
│  │   │       }                                                        │    │    │
│  │   │   }                                                            │    │    │
│  │   └────────────────────────────────────────────────────────────────┘    │    │
│  │                                                                         │    │
│  │   ┌────────────────────────────────────────────────────────────────┐    │    │
│  │   │                        LiveState                               │    │    │
│  │   │  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │    │    │
│  │   │  │ VmmHandler   │  │ GuestSession     │  │ Metrics          │  │    │    │
│  │   │  │ (Shim PID)   │  │ (gRPC to Guest)  │  │ (CPU/Mem)        │  │    │    │
│  │   │  └──────────────┘  └──────────────────┘  └──────────────────┘  │    │    │
│  │   └────────────────────────────────────────────────────────────────┘    │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      RuntimeImpl State Management                       │    │
│  │                                                                         │    │
│  │   ┌──────────────────┐  ┌───────────────────────────────────────────┐   │    │
│  │   │ pending_crashes  │  │ HashSet<BoxID>                            │   │    │
│  │   │ (RwLock)         │  │ Prevents duplicate crash handling         │   │    │
│  │   └──────────────────┘  └───────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  │   ┌──────────────────┐  ┌───────────────────────────────────────────┐   │    │
│  │   │ crash_tx         │  │ mpsc::Sender<BoxID>                       │   │    │
│  │   │ (cloned per box) │  │ Fire-and-forget crash notifications       │   │    │
│  │   └──────────────────┘  └───────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  │   ┌──────────────────┐  ┌───────────────────────────────────────────┐   │    │
│  │   │ shutdown_token   │  │ CancellationToken                         │   │    │
│  │   │ (per Runtime)    │  │ Signals shutdown to all components        │   │    │
│  │   └──────────────────┘  └───────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  │   ┌──────────────────┐  ┌───────────────────────────────────────────┐   │    │
│  │   │ crash_task_      │  │ RwLock<Vec<JoinHandle<()>>>               │   │    │
│  │   │ handles          │  │ Tracks spawned per-crash tasks            │   │    │
│  │   └──────────────────┘  └───────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Persistence Layer (SQLite)                         │
│                                                                                 │
│   BoxState {                                                                    │
│       status: BoxStatus,          // Configured | Running | Crashed | etc       │
│       stop_info: StopInfo {       // Valid when stopped/crashed/restarting      │
│           cause: StopCause,       // Normal | CrashedNoPolicy | MaxRetries      │
│           exit_code: Option<i32>, // From shim exit file                        │
│           exit_time: DateTime,    // When crash detected                        │
│           restart_count: u32,     // Attempts in current sequence               │
│           restarted_at: Option,   // Last successful restart                    │
│       },                                                                        │
│       last_restart_error: Option<String>,  // Error from last failed restart    │
│       health_status: HealthStatus,          // Health state + failure count     │
│       // ... other fields                                                       │
│   }                                                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Core Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Separation of Concerns** | Health Check detects only; Crash Handler decides and executes |
| **Non-blocking Notification** | Health Check sends via `crash_tx.send()` with 100ms timeout; drops notification on timeout |
| **Duplicate Prevention** | `pending_crashes` HashSet prevents concurrent handling of the same box |
| **Graceful Shutdown** | All components listen to `shutdown_token` |
| **Cleanup Guarantee** | Spawned task removes `pending_crashes` entry after completion |

### 1.4 Component Boundaries

| Component | Responsibility | Lifecycle |
|-----------|---------------|-----------|
| **Health Check Task** | Detect shim death, report via channel | Per Box; exits on crash, stop, or unhealthy |
| **Crash Handler Task** | Receive notifications, evaluate policy, execute restart | Per Runtime; runs until shutdown |
| **Per-Crash Handler** | Handle single crash: read exit info, backoff, restart | Per crash; exits when done or shutdown |
| **Pending Crashes Set** | Track in-flight crash handling, prevent duplicates | Runtime-scoped; guarded by RwLock |
| **Crash Task Handles** | Track spawned per-crash task JoinHandles | Runtime-scoped; periodically pruned |

### 1.5 State Machine Overview

```
[Configured] --start()--> [Running] --stop()--> [Stopped]
      |                        |                 ^
      |                        | crash           |
      |                        v                 |
      |                    [Crashed]--no policy--+
      |                        |
      |         +--------------+ restart policy
      |         v
      +----[Restarting]--success--> [Running]
                           |
                           | max attempts / cancelled
                           v
                        [Stopped]
```

**Key State Transitions**:
- `Running` → `Crashed`: Health Check detects shim process death
- `Crashed` → `Restarting`: Restart policy conditions met
- `Crashed` → `Stopped`: No policy or policy conditions not met
- `Restarting` → `Running`: Restart succeeds
- `Restarting` → `Stopped`: Cancelled or max retries exceeded

---

## Part 2: Runtime-time Mechanism

When the user process is running, the Health Check Task and Crash Handler Task work together to enable real-time crash detection and automatic recovery.

### 2.1 Crash Detection

#### 2.1.1 Health Check Task Workflow

The Health Check Task is created when a Box starts and continuously monitors the Guest's health:

```
loop:
    ├─ sleep(interval)
    ├─ In start_period? → skip ping (treat as OK)
    ├─ guest.ping() with timeout
    │   ├─ OK → mark Healthy (persist if changed)
    │   └─ Fail → check process alive
    │       ├─ Alive → count failure
    │       │   └─ retries exceeded → Unhealthy, exit
    │       └─ Dead → **CRASHED**
    │           → crash_tx.send(box_id)  (notify Crash Handler, 100ms timeout)
    │           → exit (Task ends)
    └─ shutdown_token.cancelled() → exit
```

#### 2.1.2 Two Unhealthy Scenarios

When the Health Check detects a failure, it responds differently based on shim process state:

| Scenario | Detection | Health State | Box Status | Action |
|----------|-----------|--------------|------------|--------|
| Guest unresponsive | `ping()` fails, retries exhausted | `Unhealthy` | `Running` | Mark unhealthy, stop Health Check |
| Shim process died | `is_process_alive(pid)` returns false | `Unhealthy` | `Crashed` | Send crash notification to Crash Handler |

**Key Distinction**: Only **shim process death** triggers crash handling and restart policy evaluation. Guest unresponsiveness alone does not cause a restart.

#### 2.1.3 Health Check Responsibilities

The Health Check **only does three things**:
1. Periodically ping Guest to check health
2. Detect if shim process has died
3. Send crash notification (`crash_tx.send(box_id)` with 100ms timeout)

The Health Check **does NOT**:
- Read exit info files
- Evaluate restart policies
- Handle backoff logic
- Call `restart()`

After sending the notification, the Health Check Task exits immediately (`break from loop`).

### 2.2 Crash Handling

#### 2.2.1 Crash Handler Task Architecture

The Crash Handler Task is created during `ensure_services_started()` (lazily on first async call) and is a long-running, per-Runtime task:

```rust
fn spawn_crash_handler(runtime, crash_rx) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(box_id) = crash_rx.recv() => {
                    if runtime.shutdown_token.is_cancelled() { continue; }
                    if runtime.pending_crashes.read().unwrap().contains(&box_id) { continue; }
                    runtime.pending_crashes.write().unwrap().insert(box_id.clone());
                    let rt = Arc::clone(&runtime);
                    let handle = tokio::spawn(async move {
                        Self::handle_box_crash(rt, box_id).await;
                        rt.pending_crashes.write().unwrap().remove(&box_id);
                    });
                    // Track spawned task handle
                    runtime.crash_task_handles.write().unwrap().push(handle);
                }
                _ = runtime.shutdown_token.cancelled() => { break; }
            }
        }
    })
}
```

#### 2.2.2 Single Crash Handling Flow

`handle_box_crash()` processes a single crash through the complete flow:

```
Crash Handler receives box_id
    ↓
1. Register in pending_crashes (HashSet insert)
   └─ Spawned task removes entry on completion (no CleanupGuard)
    ↓
2. Acquire per-box lock (spinloop with shutdown check)
   └─ Ensures mutual exclusion with manual restart() and other crash handlers
    ↓
3. Verify Box state (crashable: Running/Crashed)
   └─ Re-read state from DB to minimize races
    ↓
4. Read exit info
   └─ Read from shim exit file; no file defaults to exit_code = 0 (clean exit)
    ↓
5. Update state (persist before evaluation for crash metadata recovery)
   └─ status = Crashed
   └─ stop_info.exit_code = exit_code
   └─ stop_info.exit_time = now
   └─ stop_info.restart_count += 1
   └─ Persist to DB
    ↓
6. Evaluate restart policy (lock still held; uses pre-increment count)
   └─ Calls policy.should_restart(exit_code, current_restart_count)
   └─ No → Stopped, cause = stop_cause_when_restart_denied(), return
   └─ Should restart → continue
    ↓
7. Release per-box lock (end of Phase 1)
    ↓
8. Execute backoff + restart loop (lock acquired per attempt)
   Calculate backoff (exponential: 100ms, 200ms, 400ms... cap 30s)
   ↓
   tokio::select! {
       _ = sleep(delay) => {
           // Per attempt: acquire lock → restart → release lock
           acquire per-box lock
           re-read status (if Running → skip, manual restart already succeeded)
           runtime.restart(box_id).await
           release per-box lock
       }

       _ = shutdown_token.cancelled() => {
           // Runtime shutting down
           status = Stopped, cause = Normal
           return
       }
   }
   ↓
   On success: restart() resets stop_info (count=0, restarted_at=now); break loop
   On failure: persist RestartFailed, check if should_retry
       ├─ should_retry → continue loop (next backoff + attempt)
       └─ !should_retry → Stopped, cause = MaxRetriesExceeded; break
    ↓
Spawned task removes entry from pending_crashes
```

#### 2.2.3 Producer-Consumer Pattern

Health Check and Crash Handler form a **producer-consumer** relationship:

```
┌─────────────────────┐         ┌──────────────────────┐
│   Producer          │         │   Consumer           │
│   (Health Check)    │         │   (Crash Handler)    │
│                     │         │                      │
│  Detect crash       │────┐    │  Receive notification│
│  Send notification  │    │    │  Evaluate policy     │
│  Exit immediately   │    │    │  Execute restart     │
└─────────────────────┘    │    └──────────────────────┘
                           │
                    ┌──────┴──────┐
                    │ mpsc::      │
                    │ channel     │
                    └─────────────┘
```

**Design Benefits**:
1. **Decoupling**: Health Check doesn't block waiting for restart
2. **Parallelism**: Multiple crashes can be processed concurrently
3. **Mutual Exclusion**: Per-box file lock prevents conflicting restart attempts

### 2.3 Concurrency Safety

#### 2.3.1 Shutdown Ordering

The Crash Handler must listen to both `crash_rx.recv()` and `shutdown_token.cancelled()`:

```rust
loop {
    tokio::select! {
        Some(box_id) = crash_rx.recv() => { /* handle crash */ }
        _ = shutdown_token.cancelled() => { break; }
    }
}
```

If only listening to the channel, when Runtime shuts down:
- The channel won't close (producers still hold senders)
- Crash Handler never exits
- Causes shutdown to hang

#### 2.3.2 Duplicate Handling Protection

`pending_crashes: RwLock<HashSet<BoxID>>` prevents duplicate processing:

```rust
// When receiving crash notification
if pending_crashes.read().unwrap().contains(&box_id) {
    // Already being handled, skip
    continue;
}

// Before starting handling
pending_crashes.write().unwrap().insert(box_id.clone());

// The spawned task removes the entry directly after completion:
//   pending_crashes.write().unwrap().remove(&box_id);
```

#### 2.3.3 Manual Restart vs Auto-Restart Mutual Exclusion

`restart()` does **NOT** cancel pending crash handling. Mutual exclusion is ensured by the per-box file lock:

- Callers must hold the per-box lock before calling `restart()`
- Both `handle_box_crash` and recovery auto-restart tasks acquire the lock before calling `restart()`

**Race Handling**: If the crash handler's backoff sleep finishes and `restart()` was called manually while the handler was sleeping, the crash handler re-acquires the per-box lock, re-reads the box status, sees `Running`, and skips the auto-restart. This avoids conflicting restart attempts without requiring explicit cancellation.

---

## Part 3: Startup-time Mechanism

### 3.1 Why Startup Recovery is Needed

BoxLite has no daemon; Health Check runs in the user process. When the user process exits:
- VM may continue running (detach mode)
- VM may crash
- No monitoring, no automatic recovery

When the user **restarts the process** and calls `Runtime::new()`, we need to check the status of these "orphan" Boxes.

### 3.2 recover_boxes() Flow

```
Runtime::new()
    ↓
recover_boxes() ──► Iterate all persisted boxes
    │
    ├─ Phase 0: Cleanup orphaned directories (no DB record)
    ├─ Phase 1: Remove auto_remove=true boxes and orphaned active boxes
    ├─ Phase 1.5: Recover interrupted snapshots
    │
    ├─ Phase 2: For each remaining box:
    │   ├─ Read PID file
    │   │   ├─ Process alive + same process ──► Reattach, set Running
    │   │   └─ Process dead / no PID file ──► Not running, evaluate restart policy
    │   │       ├─ None / No ──► Mark Stopped, cause = CrashedNoPolicy
    │   │       ├─ OnFailure + exit_code == 0 ──► Mark Stopped, cause = Normal
    │   │       ├─ OnFailure + max_retries exceeded ──► Mark Stopped, cause = MaxRetriesExceeded
    │   │       ├─ OnFailure + non-zero exit + under max_retries ──► Queue for auto-restart
    │   │       ├─ Always ──► Queue for auto-restart
    │   │       ├─ UnlessStopped + cause=Normal ──► Mark Stopped (user explicitly stopped)
    │   │       └─ UnlessStopped + cause!=Normal ──► Queue for auto-restart
    │   └─ Persist updated state
    ↓
Return list of boxes to auto-restart (stored in recovery_queue)
    ↓
ensure_services_started() (lazily on first async call)
    ├─ Spawn crash handler task
    └─ Spawn async task for auto-restart (sequential, with per-box lock)
    ↓
Runtime ready to accept requests
```

### 3.3 Runtime-time vs Startup-time Comparison

| Characteristic | Runtime-time | Startup-time |
|----------------|-------------|--------------|
| **Trigger** | Health Check detects crash | `Runtime::new()` called |
| **Handler** | Crash Handler Task | `recover_boxes()` + `ensure_services_started()` |
| **Execution** | Async (spawn task) | State evaluation synchronous; auto-restart async |
| **Response Latency** | Milliseconds | Seconds (startup overhead) |
| **Communication** | `mpsc::channel` | Direct function call |
| **Concurrency** | Multiple crashes in parallel | Sequential processing |
| **Mutual Exclusion** | Per-box file lock | Per-box file lock |

### 3.4 Why Two Mechanisms are Needed

**Runtime-time**:
- User process is running
- Real-time crash response needed
- Supports complex concurrency control

**Startup-time**:
- User process just started
- Crash Handler Task not yet created
- Must recover existing Boxes before serving requests

**Complementary Relationship**:
- Runtime-time handles "real-time monitoring while running"
- Startup-time handles "state recovery after process restart"
- Together they cover the complete Box lifecycle

---

## Part 4: Configuration Guide

### 4.1 Restart Policy Types

```rust
pub enum RestartPolicy {
    No,                             // Never restart (default)
    Always,                         // Always restart
    OnFailure { max_retries: u32 }, // Restart on non-zero exit, limited retries
    UnlessStopped,                  // Always restart unless explicitly stopped
}
```

**Policy Semantics**:

| Policy | Restart Condition | Retry Limit | Use Case |
|--------|-------------------|-------------|----------|
| `No` | Never | N/A | Development, one-off tasks |
| `Always` | Always (any exit code) | Unlimited | Services that must stay running |
| `OnFailure { max_retries }` | Exit code != 0 only (`None` = clean exit) | `max_retries` | Fault-tolerant with ceiling |
| `UnlessStopped` | Always at runtime; only `cause != Normal` at recovery | Unlimited | Long-running services |

### 4.2 Auto-Enable Health Check

Restart policies require a monitoring mechanism to work. When `restart_policy` is set but `health_check` is not, the system **auto-enables** a default Health Check:

```rust
// effective_health_check() logic
if user_configured_health_check {
    Some(user_config)  // Use user config
} else if restart_policy.is_some() {
    Some(default_config)  // Auto-enable default
} else {
    None  // No monitoring
}
```

**Default Configuration**:
- `interval`: 5s (user default is 30s, policy needs faster detection)
- `timeout`: 10s
- `retries`: 3
- `start_period`: 60s

### 4.3 Configuration Matrix

| Health Check | Restart Policy | Behavior |
|-------------|----------------|----------|
| Configured | Configured | Use user Health Check, trigger policy on crash |
| Not configured | Configured | Auto-enable default Health Check |
| Configured | Not configured | Health Check marks unhealthy, no auto-restart |
| Not configured | Not configured | No monitoring, no restart |

### 4.4 Configuration Examples

**Basic Configuration**:

```python
import boxlite

runtime = await boxlite.Runtime.new()

# Always policy - always restart
box1 = await runtime.create_box(
    image="python:3.11",
    advanced=boxlite.AdvancedBoxOptions(
        restart_policy=boxlite.RestartPolicy.ALWAYS
    )
)

# OnFailure policy - max 3 retries
box2 = await runtime.create_box(
    image="worker:latest",
    advanced=boxlite.AdvancedBoxOptions(
        restart_policy=boxlite.RestartPolicy.ON_FAILURE(max_retries=3)
    )
)

# UnlessStopped policy - restart unless explicitly stopped
box3 = await runtime.create_box(
    image="server:latest",
    advanced=boxlite.AdvancedBoxOptions(
        restart_policy=boxlite.RestartPolicy.UNLESS_STOPPED
    )
)
```

**Custom Health Check + Policy**:

```python
box = await runtime.create_box(
    image="api:latest",
    health_check=boxlite.HealthCheckOptions(
        interval=10,      # Check every 10 seconds
        timeout=5,        # 5 second timeout
        retries=5,        # Mark unhealthy after 5 failures
        start_period=120  # Don't count failures for 120s after start
    ),
    advanced=boxlite.AdvancedBoxOptions(
        restart_policy=boxlite.RestartPolicy.ON_FAILURE(max_retries=5)
    )
)
```

**Detach Mode + Policy**:

```python
box = await runtime.create_box(
    image="daemon:latest",
    detach=True,  # VM continues after process exits
    advanced=boxlite.AdvancedBoxOptions(
        restart_policy=boxlite.RestartPolicy.UNLESS_STOPPED
    )
)

# After process exits, if VM crashes, detection happens on next get()
box_ref = await runtime.get_box(box.id)
await box_ref.start()  # Restart if needed
```

### 4.5 Restart Policy vs Detach Mode

**Key Distinction**: Auto-restart only works while user process is running.

```
Normal Mode (detach=false):
    User process running ──► BoxImpl in memory ──► Health Check active
                                │
                                ▼ Shim death detected
                        Immediate auto-restart ✅

Detach Mode (detach=true):
    User process running ──► BoxImpl in memory ──► Health Check active
            │                  │
            ▼                  ▼ User exits
    Process exits      BoxImpl dropped, Health Check stopped
            │                  │
            │                  ▼ VM crashes
            │             No Health Check, no auto-restart ❌
            │                  │
            ▼                  ▼
    User restarts process  Crash detected on next get()/start()
            │                  │
            └──────────────────┘
                        │
                        ▼
                Manual restart() to recover
```

**Detach Mode Implication**: "Decouple VM lifecycle from process lifecycle". User accepts responsibility for managing the Box after process exit.

---

## Part 5: Implementation Details

### 5.1 Restart Method Implementation

`restart()` follows the same pattern as `stop()`: invalidate old `BoxImpl`, create new one, call `start()`.

**Important**: Callers must hold the per-box lock before calling `restart()` -- `restart()` does NOT acquire it internally. Both `handle_box_crash` and recovery auto-restart tasks acquire the lock before calling `restart()`.

```
SharedRuntimeImpl::restart(box_id)
    │
    ├─ 1. Read existing config and state from DB
    │
    ├─ 2. If active BoxImpl in cache:
    │      Abort its Health Check Task
    │      Cancel shutdown_token (makes old BoxImpl unusable)
    │
    ├─ 3. Invalidate old BoxImpl from cache
    │      invalidate_box_impl(box_id, box_name)
    │
    ├─ 4. Update state: status=Restarting, clear health, persist
    │
    ├─ 5. Create new BoxImpl
    │      Empty OnceCell, new shutdown_token
    │
    ├─ 6. Call start() on new BoxImpl
    │      → OnceCell empty → init_live_state()
    │      → BoxBuilder sees status=Restarting → restart pipeline
    │      → New VM starts, new Health Check Task
    │
    └─ 7. Reset stop_info
           stop_info = StopInfo::default()
           stop_info.restarted_at = now()
           Persist
```

### 5.2 BoxBuilder Restart Pipeline

`BoxBuilder` treats `Restarting` the same as `Stopped`: reuse existing COW disks, spawn new VM:

```rust
fn get_execution_plan(status: BoxStatus) -> ExecutionPlan<InitCtx> {
    match status {
        BoxStatus::Configured => { /* Full pipeline */ }
        BoxStatus::Stopped | BoxStatus::Restarting => {
            // Restart pipeline: reuse COW disks, spawn new VM, connect, init
        }
        BoxStatus::Running => { /* Reattach pipeline */ }
        _ => panic!("Invalid status for initialization"),
    }
}
```

The distinction between `Restarting` and `Stopped` exists only at the state machine level for observability—the Builder executes the same pipeline.

### 5.3 Backoff Calculation

```rust
pub fn calculate_backoff(restart_count: u32) -> Duration {
    let base_ms: u64 = 100;
    let max_ms: u64 = 30_000;
    let exp = 1u64.checked_shl(restart_count.min(18)).unwrap_or(u64::MAX);
    Duration::from_millis(base_ms.saturating_mul(exp).min(max_ms))
}
```

**Backoff Sequence**: 100ms → 200ms → 400ms → 800ms → ... → 30s (cap)

### 5.4 StopCause Tracking

`StopCause` is set by different code paths to record why a Box stopped:

| Method | Cause | Scenario |
|--------|-------|----------|
| `mark_stop()` | `Normal` | User called `stop()` or normal exit |
| `reset_for_reboot()` | `SystemReboot` | System reboot detected during recovery |
| Crash handler (no policy) | `CrashedNoPolicy` | Shim crashed, no restart policy (`No` or `None`) |
| Crash handler (OnFailure, clean exit) | `Normal` | `exit_code == 0` or `None`, not a failure |
| Crash handler (OnFailure, max retries) | `MaxRetriesExceeded` | Policy exhausted retry budget |
| Crash handler (restart attempt failed) | `RestartFailed` | A restart attempt failed but retries may continue |
| Crash handler (backoff loop, max retries) | `MaxRetriesExceeded` | Restart attempt failed and no retries left |
| Recovery (`UnlessStopped`, user stopped) | `Normal` | `stop_info.cause == Normal` during startup recovery |
| `restart()` success | `Normal` (default) | Reset stop_info on successful restart |
| Defensive code | `Unknown` | Unreachable branch (should not happen) |

**UnlessStopped policy** uses `StopCause::Normal` to distinguish user-initiated stops from crashes. During recovery, if `stop_info.cause == Normal`, auto-restart should not occur.

### 5.5 Restart Counter

The counter exists both in-memory (for backoff) and persisted (for recovery).

**In-memory counter** (inside Crash Handler Task):
```rust
let current_restart_count = state.stop_info.restart_count;
let new_restart_count = current_restart_count + 1;
let backoff = calculate_backoff(current_restart_count);
```

**Persisted counter** (`state.stop_info.restart_count`):
- Written to DB on each crash: `restart_count += 1`
- Reset on successful restart: `restart()` sets `stop_info` to default (`count=0`)
- `OnFailure` policy: `should_restart()` checks `restart_count < max_retries` (strict less-than)

**Design Rationale**:
- Resetting on success ensures each "crash sequence" has independent retry budget
- Persisted counter enables cross-process recovery

### 5.6 State Definitions

```rust
pub enum BoxStatus {
    Unknown,
    Configured,
    Running,
    Stopping,
    Stopped,
    Crashed,
    Restarting,
    Paused,
}

impl BoxStatus {
    /// Only Running boxes have an active VM process that needs monitoring
    /// Restarting is transient—monitoring starts after transition to Running
    pub fn requires_monitoring(&self) -> bool {
        matches!(self, BoxStatus::Running)
    }
}

/// Why the box stopped
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopCause {
    #[default]
    Normal,           // User called stop() or normal exit
    CrashedNoPolicy,  // Crashed but no restart policy
    MaxRetriesExceeded,  // Policy exhausted retries
    SystemReboot,     // System reboot detected
    RestartFailed,    // Restart attempt failed (e.g., VM failed to start)
    Unknown,          // Unexpected state (should not happen in normal operation)
}

/// Stop info (valid when status is Stopped/Crashed)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StopInfo {
    pub cause: StopCause,
    pub exit_code: Option<i32>,
    pub exit_time: Option<DateTime<Utc>>,
    pub restart_count: u32,
    pub restarted_at: Option<DateTime<Utc>>,
}

pub struct BoxState {
    pub status: BoxStatus,
    pub stop_info: StopInfo,
}
```

### 5.7 API Reference

```rust
pub enum RestartPolicy {
    No,
    Always,
    OnFailure { max_retries: u32 },
    UnlessStopped,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AdvancedBoxOptions {
    #[serde(default)]
    restart_policy: Option<RestartPolicy>,
}
```

---

## Appendix: FAQ

### Q: Why doesn't BoxLite have a Daemon?

BoxLite is designed as "SQLite for sandboxing"—a lightweight embedded library without a background service. This brings:
- Simple deployment: No daemon to manage
- Resource efficiency: No resident memory overhead
- Security boundary: No shared privileged process

The trade-off: No monitoring after process exit, requiring Startup Recovery.

### Q: Why are Health Check and Crash Handler separated?

**Separation of Concerns**:
- Health Check is bound to BoxImpl lifecycle
- Crash Handler needs to manage Box lifecycle (including creating new BoxImpl)
- If Health Check directly handled restart, it would create circular dependency

After separation:
- Health Check only detects and reports
- Crash Handler decides and orchestrates
- Clear data flow: `channel` decouples them

### Q: Does manually calling `start()` on a stopped box trigger the policy?

No. Calling `start()` on a stopped box invokes the internal `restart()` method, which is a **forced restart** that:
1. Acquires the per-box lock (caller holds it)
2. Immediately restarts the Box
3. Resets `stop_info`

If a crash handler's backoff sleep finishes after the manual restart, it re-acquires the lock, re-reads the status, sees `Running`, and skips the auto-restart.

The policy is only evaluated when a **crash is detected**.

### Q: Does the policy work in Detach mode?

**Only while the user process is running**. In Detach mode:
- User process running: Health Check active, crashes detectable, policy effective
- User process exited: Health Check stopped, crashes undetectable
- Next startup: Startup Recovery detects crashes but policy evaluation differs

If you need monitoring after process exit, BoxLite is not the right solution (consider container runtimes with a daemon).
