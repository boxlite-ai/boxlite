# BoxLite PR Summary

---

## Submitted PRs

### [PR #406](https://github.com/boxlite-ai/boxlite/pull/406) — fix(jailer): Dynamic FD Closure

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/406 |
| Branch | `fix/jailer-dynamic-fd-closure` |
| Commit | `28e2ce4` |
| Category | Security fix |
| Files changed | 1 file, +257 / -15 |

**Problem:** FD cleanup in jailer `pre_exec` used hardcoded upper bounds (1024 on Linux, 4096 on macOS). On systems with raised `ulimit -n`, FDs above these limits leaked into jailed processes, potentially exposing credentials, database connections, or network sockets.

**Solution:** 3-strategy cascade (Linux):
1. `close_range(first_fd, ~0U, 0)` — O(1), Linux 5.9+
2. `/proc/self/fd` enumeration via raw `getdents64` — no heap allocation
3. Brute-force close with dynamic limit from `getrlimit(RLIMIT_NOFILE)`

macOS uses brute-force with dynamic `getrlimit` limit. All operations remain async-signal-safe for the `pre_exec` context.

---

### [PR #407](https://github.com/boxlite-ai/boxlite/pull/407) — feat(vmm): pidfd/kqueue Event-Driven Process Monitor

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/407 |
| Branch | `feat/pidfd-kqueue-process-monitor` |
| Commit | `78d484e` |
| Category | Performance |
| Files changed | 2 files, +467 / -18 |

**Problem:** `ProcessMonitor::wait_for_exit()` used a 500ms sleep-based polling loop (`tokio::time::sleep` + `try_wait`), violating Rule #15: "No Sleep for Events." This added up to 500ms latency to VM crash detection during startup.

**Solution:** Platform-native event-driven mechanisms:
- **Linux**: `pidfd_open()` (kernel 5.3+) + tokio `AsyncFd`
- **macOS**: `kqueue` + `EVFILT_PROC` + `NOTE_EXIT` + tokio `AsyncFd`
- **Fallback**: 100ms polling for older kernels (< 5.3)

Key design: `OwnedFd` wraps raw FDs immediately (leak-free by construction), `fcntl O_NONBLOCK` with graceful fallback, best-effort race guard via `is_alive()` after FD setup.

---

### [PR #408](https://github.com/boxlite-ai/boxlite/pull/408) — feat(python-sdk): EventListener + Typed Errors

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/408 |
| Branch | `feat/python-event-listener-typed-errors` |
| Commit | `e5ad727` |
| Category | SDK feature |
| Files changed | 17 files, +1050 / -75 |

**Problem:** Python SDK had no way to receive push-based lifecycle callbacks. All errors were generic `PyRuntimeError`, making programmatic error handling impossible.

**Solution:**
- **PyEventListener** bridge: duck-typing via PyO3, missing methods silently skipped
- **Typed exceptions**: 15 exception classes inheriting from `BoxliteError`, exhaustive match on all 18 `BoxliteError` variants for compile-time completeness
- **`event_listeners`** parameter on `BoxliteOptions`, propagated through `RuntimeImpl`
- **165 Python tests** covering exception hierarchy, isolation, and exports

---

### [PR #409](https://github.com/boxlite-ai/boxlite/pull/409) — feat(portal): Streaming File Upload

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/409 |
| Branch | `feat/streaming-file-upload` |
| Commit | `37ca16f` |
| Category | Performance |
| Files changed | 1 file, +365 / -36 |

**Problem:** `upload_tar` buffered the entire file into a `Vec`, causing memory usage of O(file_size). Large file uploads could OOM the host process.

**Solution:** Bounded `mpsc` channel (capacity=4) with a spawned reader task, capping peak memory at ~5 MiB regardless of file size. Matches the streaming pattern already used in `download_tar` and guest-side upload handler.

Key design: `stream_file_chunks` helper accepts `impl AsyncRead` for testability, `std::mem::take` for zero-copy first chunk, always await reader `JoinHandle` before checking gRPC result (root-cause priority). 8 unit tests added.

---

### [PR #413](https://github.com/boxlite-ai/boxlite/pull/413) — feat(litebox): Pause/Resume API for Zero-CPU VM Freezing

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/413 |
| Branch | `feat/pause-resume-api` |
| Commit | `ded35bf` |
| Category | Feature |
| Files changed | 16 files, +1430 / -48 |

**Problem:** Running VMs consume CPU even when idle. For AI agent sandboxes that run intermittently, there was no way to suspend a VM and reclaim compute resources without destroying the box.

**Solution:** Full pause/resume lifecycle with `SIGSTOP`/`SIGCONT` signals:
- **`LiteBox::pause()`** / **`resume()`** with state machine enforcement (`Running` ↔ `Paused`)
- **Quiesced tracking**: Operations that observe the paused state are tracked; if a pause fails, the box is marked `QuiesceFailed` rather than silently reverting
- **ESRCH race handling**: Graceful handling of process-already-gone races during signal delivery
- **SDK bindings**: Python (`await box.pause()` / `await box.resume()`), Node.js (`box.pause()` / `box.resume()`)
- **Audit events**: `BoxPaused` / `BoxResumed` emitted through EventListener
- **REST API**: `POST /boxes/{id}/pause` / `POST /boxes/{id}/resume`
- **350-line integration test suite** + Python example script

---

### [PR #415](https://github.com/boxlite-ai/boxlite/pull/415) — fix(box_impl): Offload Blocking handler.stop() and metrics() to spawn_blocking

| Item | Detail |
|------|--------|
| URL | https://github.com/boxlite-ai/boxlite/pull/415 |
| Branch | `fix/spawn-blocking-handler` |
| Commit | `8d043d1` |
| Category | Performance fix |
| Files changed | 1 file, +22 / -11 |

**Problem:** `ShimHandler::stop()` uses a `std::thread::sleep(50ms)` polling loop (up to 2 seconds total) and `metrics()` performs synchronous sysinfo I/O. Both are called from async `BoxImpl` methods, blocking Tokio worker threads and causing latency spikes for concurrent operations.

**Solution:** Wrap `handler` field in `Arc<std::sync::Mutex<...>>` and offload both blocking calls via `tokio::task::spawn_blocking`:
- **`stop()`**: Swallows lock poison (shutdown must proceed regardless)
- **`metrics()`**: Propagates lock poison (monitoring should surface anomalies)
- **Double `??` pattern**: `spawn_blocking` returns `Result<Result<T, E>, JoinError>` — first `?` unwraps JoinError, second unwraps inner BoxliteError

---

### C2 fix (PR pending) — fix(exec): Remove UB in Python SDK by Relaxing Execution Methods to &self

| Item | Detail |
|------|--------|
| URL | *PR not yet created* |
| Branch | `fix/execution-remove-unsafe` |
| Commit | `4e76d8c` |
| Category | Safety / UB fix |
| Files changed | 2 files, +10 / -15 |

**Problem:** Python SDK `PyExecution` created `&mut Execution` from a shared `Arc<Execution>` via `unsafe { &mut *(Arc::as_ptr(&self.execution) as *mut Execution) }` — 5 occurrences. This violates Rust's aliasing rules and is Undefined Behavior.

**Solution:** Two-layer fix:
1. **Core library** (`src/boxlite/src/litebox/exec.rs`): Relax 5 `Execution` methods from `&mut self` to `&self` — safe because all mutation goes through the inner `Arc<tokio::sync::Mutex<ExecutionInner>>`
2. **Python SDK** (`sdks/python/src/exec.rs`): Remove all 5 `unsafe` blocks, call methods directly via `Arc::Deref`

---

## Summary Stats

| PR | Category | Lines Changed |
|----|----------|--------------|
| [#406](https://github.com/boxlite-ai/boxlite/pull/406) Dynamic FD Closure | Security | +257 / -15 |
| [#407](https://github.com/boxlite-ai/boxlite/pull/407) pidfd/kqueue ProcessMonitor | Performance | +467 / -18 |
| [#408](https://github.com/boxlite-ai/boxlite/pull/408) Python EventListener + Typed Errors | SDK | +1050 / -75 |
| [#409](https://github.com/boxlite-ai/boxlite/pull/409) Streaming File Upload | Performance | +365 / -36 |
| [#413](https://github.com/boxlite-ai/boxlite/pull/413) Pause/Resume API | Feature | +1430 / -48 |
| [#415](https://github.com/boxlite-ai/boxlite/pull/415) spawn_blocking for handler | Performance fix | +22 / -11 |
| C2 (pending) Remove Execution UB | Safety / UB fix | +10 / -15 |
| **Total** | | **+3611 / -218** |
