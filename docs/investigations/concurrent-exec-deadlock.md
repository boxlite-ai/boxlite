# Concurrent Exec Deadlock: Root Cause Analysis

**Date:** 2026-03-10
**Branch:** `test/concurrent-exec-deadlock-coverage`
**Severity:** Critical — indefinite hang under concurrent exec load
**Reproduction rate:** ~30-50% per test run (8 concurrent `exec("echo ...")` to same VM)

---

## Conclusion

### Root Cause: musl `__malloc_lock` deadlock after `clone3()` in multi-threaded process

The guest binary (`boxlite-guest`) is statically linked against **musl libc**
(`aarch64-unknown-linux-musl`) and runs a multi-threaded **tokio runtime**. When
libcontainer calls `clone3()` to fork the intermediate process, the child inherits
a **locked copy of `__malloc_lock`** (musl's global allocator mutex, symbol at
`0x16f6e68` in BSS) from another tokio thread that was performing a heap allocation
at the moment of the fork. Since musl does not implement `pthread_atfork` handlers
to reset `__malloc_lock` in the child, the intermediate process deadlocks on its
very first memory allocation — before it can send any channel messages or close
inherited file descriptors. The parent then blocks forever on `recvmsg()`.

### Deadlock Call Graph

```
TOKIO RUNTIME (multi-threaded, PID 1 inside guest VM)
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Thread A (tokio-runtime-w)        Thread B (any tokio thrd) │
│  ┌───────────────────────────┐     ┌────────────────────────┐│
│  │ ExecService::exec()       │     │ (doing any work)       ││
│  │   ↓                       │     │   ↓                    ││
│  │ ContainerExecutor::spawn()│     │ Vec::push() / String   ││
│  │   ↓                       │     │ ::from() / format!()   ││
│  │ container.lock().await    │     │   ↓                    ││
│  │   ↓                       │     │ malloc()               ││
│  │ spawn_blocking {          │     │   ↓                    ││
│  │   builder.build()         │     │ lock(__malloc_lock) ◄━━━━━ HOLDS
│  │     ↓                    │     │ 0x16f6e68 = 0x02      ││
│  │   tenant_builder.build() │     │   ↓                    ││
│  │     ↓                    │     │ (memcpy, split, etc.)  ││
│  │   builder_impl.create()  │     │   ↓                    ││
│  │     ↓                    │     │ unlock(__malloc_lock)   ││
│  │   run_container()        │     └────────────────────────┘│
│  │     ↓                    │                                │
│  │   container_main_process │                                │
│  │     ↓                    │                                │
│  │   socketpair() x3        │  Creates 6 fds:               │
│  │   (SEQPACKET+CLOEXEC)    │    main_sender    (ms)        │
│  │     ↓                    │    main_receiver   (mr)        │
│  │                          │    inter_sender   (is)        │
│  │   ════════════════════════════════════════════════════    │
│  │   clone3()  ← FORK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━    │
│  │   ════════════════════════════════════════════════════    │
│  │     ↓ (parent path)      │                                │
│  │   close(ms) ✓            │                                │
│  │   close(is) ✓            │                                │
│  │     ↓                    │                                │
│  │   mr.recv() ━━━━━━━━━━━━━━━━━━━━━ BLOCKS FOREVER        │
│  │   (recvmsg on SEQPACKET) │   (peer ms still open in     │
│  │   (syscall 212, aarch64) │    child process)             │
│  └───────────────────────────┘                               │
└──────────────────────────────────────────────────────────────┘

═══════════════════════════════ clone3() boundary ══════════════

INTERMEDIATE PROCESS (PID 248, single-threaded child)
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Inherited from fork:                                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ • ALL 6 channel fds (ms, mr, is, ir, xs, xr)          │  │
│  │ • __malloc_lock at 0x16f6e68 = 0x80000002 (LOCKED)     │  │
│  │ • Thread B DOES NOT EXIST in this process              │  │
│  │ • musl has NO pthread_atfork to reset __malloc_lock    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  container_intermediate_process()                            │
│    ↓                                                         │
│  FIRST LINE OF CODE that does heap allocation:               │
│    Vec::new(), String::from(), format!(), PathBuf, Box, etc. │
│    ↓                                                         │
│  malloc() → lock(__malloc_lock) → futex(FUTEX_WAIT_PRIVATE)  │
│    ↓                                                         │
│  ═══════════ DEADLOCK ═══════════                            │
│  Lock owner (Thread B) does not exist in child.              │
│  futex will NEVER be woken.                                  │
│                                                              │
│  Consequences:                                               │
│    ✗ NEVER sends intermediate_ready to parent                │
│    ✗ NEVER forks init process                                │
│    ✗ NEVER closes inherited channel fds:                     │
│        fd=23 → main_sender   (peer of parent's mr)           │
│        fd=25 → inter_sender  (peer of parent's ir)           │
│    ✗ NEVER exits                                             │
│                                                              │
│  Parent's recv() consequence:                                │
│    poll(mr) → revents=0x0 (peer alive, no POLLHUP)           │
│    FIONREAD → 0 bytes available                              │
│    → recvmsg blocks forever                                  │
└──────────────────────────────────────────────────────────────┘
```

### Why Intermittent (~30-50%)

The deadlock only occurs when `__malloc_lock` is held by another thread at the
exact moment of `clone3()`. With multiple tokio workers doing frequent allocations,
the probability of overlap is significant but not 100%:

```
Thread B:    ──────[ malloc ]───────[ malloc ]───────[ malloc ]──
                      ▲                                 ▲
                  lock held                         lock held
                  (few μs)                          (few μs)

clone3():    ─────────┼───────────────┼──────────────────┼──────
                   DEADLOCK          SAFE             DEADLOCK
```

### Why musl-Specific

| Behavior                  | glibc                           | musl                           |
|---------------------------|----------------------------------|---------------------------------|
| `pthread_atfork` for malloc | Yes — resets locks in child     | **No** — explicitly unsupported |
| `__malloc_lock` in child  | Reset to unlocked state          | **Copied as-is (locked)**       |
| fork() safety             | Mostly safe for malloc           | **Unsafe if other threads malloc** |

### Fix Options

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| **A** | Watchdog kill + retry | Quick, no libcontainer changes | Latency on retry |
| **B** | Pre-fork helper process | Eliminates entire bug class | Architecture complexity |
| **C** | Close fds before alloc in child | Fixes fd leak | Doesn't fix futex deadlock |
| **D** | Switch to glibc | Directly fixes root cause | Larger binary, dynamic linking |
| **E** | vfork / CLONE_VFORK | Clean fork-level fix | Significant libcontainer changes |

Recommended: **A (short-term) + B (long-term)**

### Upstream Status (youki)

This is a **known issue** in the youki project, tracked as
[containers/youki#2144](https://github.com/containers/youki/issues/2144)
("cargo test with musl hangs occasionally"), filed July 2023 by maintainer `yihuaf`.

**The issue is NOT fixed in any version, including v0.6.0.** Upstream applied
workarounds only:

| PR | Action | Date | Status |
|----|--------|------|--------|
| [#2150](https://github.com/containers/youki/pull/2150) | Disabled flaky musl test in CI | Jul 2023 | Merged |
| [#2615](https://github.com/containers/youki/pull/2615) | Attempted fix: leak `Box` closure to avoid `free()` in child | — | Closed, not merged |
| [#2685](https://github.com/containers/youki/pull/2685) | Set `--test-threads=1` to serialize all tests | Feb 2024 | Merged |

From PR #2685: *"the root cause comes from tests running in multiple threads,
and should not occur in actual use."*

**Why upstream dismisses it but it affects BoxLite:**

```
Upstream youki:   youki CLI (single-threaded) → clone3() → safe ✓
BoxLite guest:    tokio runtime (multi-threaded) → spawn_blocking → clone3() → DEADLOCK ✗
```

Upstream assumes youki runs as a standalone single-threaded CLI binary. In that
context, no other threads hold `__malloc_lock` at fork time. BoxLite embeds
`libcontainer` inside a multi-threaded tokio runtime — the exact scenario upstream
considers "should not occur in actual use."

**Upgrading libcontainer will not fix this.** The [v0.6.0 release](https://github.com/containers/youki/releases/tag/v0.6.0)
(Feb 2025) contains no changes to clone3, fork, or multi-threading behavior. The
fix must come from BoxLite's side.

---

## Debug Process

### Step 1: Reproduce the Stall

**Tool:** `cargo test` with `--nocapture`, loop runner

Ran the test `test_concurrent_exec_high_concurrency` in a loop. The test sends 8
concurrent `exec("echo hello_N")` RPCs to the same VM and waits for all to complete.

```bash
for i in $(seq 1 10); do
  cargo test -p boxlite --features link-krun \
    --test execution_shutdown test_concurrent_exec_high_concurrency \
    -- --nocapture 2>&1
done
```

**Observation:** ~30-50% failure rate. When it stalls, one exec never returns,
and the test times out at 120s. The stall always occurs during
`TenantContainerBuilder::build()` inside the guest VM.

**Conclusion:** Reproducible race condition. The serialized container mutex means
only one build() runs at a time, yet it still stalls intermittently.

---

### Step 2: Identify Where build() Hangs

**Tool:** Source code reading of libcontainer (youki v0.5.7)

Traced the call path through these files:

```
guest/src/service/exec/executor.rs    → ContainerExecutor::spawn()
guest/src/container/command.rs        → build_and_spawn()
libcontainer/tenant_builder.rs        → TenantContainerBuilder::build()
libcontainer/builder_impl.rs          → ContainerBuilderImpl::create()
                                      → run_container()
libcontainer/container_main_process.rs → container_main_process()
libcontainer/process/channel.rs       → channel pairs (SEQPACKET)
libcontainer/process/fork.rs          → clone3() without CLONE_FILES
```

**Key findings from code reading:**

- `build()` creates a pipe (O_CLOEXEC), then calls `create()` which calls
  `container_main_process()`
- `container_main_process()` creates 3 channel pairs using
  `socketpair(AF_UNIX, SOCK_SEQPACKET, SOCK_CLOEXEC)`, then calls `clone3()`
- After fork, parent closes `main_sender` and `inter_sender`, then blocks on
  `main_receiver.wait_for_intermediate_ready()` (a `recvmsg` call)
- Channel `Sender`/`Receiver` wrap raw fds with **no Drop impl** — fds must be
  explicitly closed or they leak
- `clone3()` is called **without** `CLONE_FILES` — child gets its own fd table copy
- The intermediate process calls `clone3_sibling` with `CLONE_PARENT` and **no
  exit signal** to fork the init process

**Conclusion:** The hang is in `recvmsg` on the `main_receiver` SEQPACKET socket,
waiting for the intermediate process to send `intermediate_ready`.

---

### Step 3: Add Watchdog Diagnostic Thread

**Tool:** Custom diagnostic code in `guest/src/container/command.rs`

Added a watchdog thread that fires after 3 seconds if `build()` hasn't completed:

```rust
let done = Arc::new(AtomicBool::new(false));
let done_clone = done.clone();
let parent_tid = nix::unistd::gettid().as_raw();

let watchdog = std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(3));
    if done_clone.load(Ordering::Relaxed) { return; }
    eprintln!("[guest-diag] watchdog: build() still running after 3s");
    // ... diagnostic code ...
});
```

**Initial diagnostic:** Scanned `/proc` for youki/child processes.

**Finding:** No youki-named child processes found. Parent thread wchan =
`__skb_wait_for_more_packets` (SEQPACKET socket recv wait).

**Conclusion:** The hang is confirmed in the parent's channel recv, and no
obviously-named child processes are alive.

---

### Step 4: Read Parent Thread Syscall Info

**Tool:** `/proc/self/task/<tid>/wchan` and `/proc/self/task/<tid>/syscall`

Added to watchdog:
```rust
let wchan = std::fs::read_to_string(
    format!("/proc/self/task/{}/wchan", parent_tid)
);
let syscall = std::fs::read_to_string(
    format!("/proc/self/task/{}/syscall", parent_tid)
);
```

**Result across all stalls:**
```
wchan   = __skb_wait_for_more_packets
syscall = 212 0x18 ...    (212 = recvmsg on aarch64, 0x18 = fd 24)
```

**Conclusion:** Parent is blocked on `recvmsg(fd=24)`. The fd number varies by run
(24 or 23) due to fd allocation holes, but is always the `main_receiver` SEQPACKET
channel socket.

---

### Step 5: Dump All Open File Descriptors

**Tool:** `/proc/self/fd/` readlink scan

Added to watchdog (first round only):
```rust
if let Ok(entries) = std::fs::read_dir("/proc/self/fd") {
    for fd in sorted_fds {
        let link = std::fs::read_link(format!("/proc/self/fd/{}", fd));
        eprintln!("[guest-diag]   fd={}: {}", fd, link);
    }
}
```

**Result (typical stall):**
```
fd=22: socket:[1243]    ← NotifyListener (STREAM)
fd=24: socket:[1245]    ← BLOCKED (main_receiver, SEQPACKET)
fd=26: socket:[1247]    ← channel socket
fd=27: socket:[1248]    ← channel socket
fd=28: socket:[1249]    ← channel socket
```

**Conclusion:** 4 SEQPACKET sockets remain open (6 created - 2 closed senders = 4).
This matches the expected state after parent closes `main_sender` and `inter_sender`.

---

### Step 6: Inspect Socket State via /proc/net/unix

**Tool:** `/proc/net/unix` filtered by socket inodes

Collected socket inodes from the fd dump, then filtered `/proc/net/unix`:

```rust
// Collect inodes from socket:[NNNN] links
let mut socket_inodes: Vec<String> = Vec::new();
// ... extract inodes from readlink results ...

// Match against /proc/net/unix
if let Ok(content) = std::fs::read_to_string("/proc/net/unix") {
    for line in content.lines() {
        if socket_inodes.iter().any(|ino| line.contains(ino)) {
            eprintln!("[guest-diag]   {}", line);
        }
    }
}
```

**Result:**
```
Inode  Type  St  RefCount
1243   0001  01  00000002   tenant-notify-*.sock (STREAM, listening)
1245   0005  03  00000003   SEQPACKET, connected
1247   0005  03  00000003   SEQPACKET, connected
1248   0005  03  00000003   SEQPACKET, connected
1249   0005  03  00000003   SEQPACKET, connected
```

**Key observation:** All SEQPACKET sockets show `RefCount=3`. For a connected
Unix socketpair, RefCount=3 means: 1 (self) + 1 (file/fd) + 1 (peer reference).
This indicates the **peer sockets are still alive** — someone still holds the
sender-side fds.

**Conclusion:** The sender-side peers are alive despite the parent having closed
its copies. Something else holds copies of `main_sender` and `inter_sender`.

---

### Step 7: Check Peer Liveness via poll() and FIONREAD

**Tool:** `poll()` syscall and `ioctl(FIONREAD)` on the blocked fd

Added to watchdog:
```rust
if let Some(fd) = blocked_fd {
    let mut pfd = nix::libc::pollfd {
        fd, events: POLLIN | POLLHUP | POLLERR, revents: 0
    };
    let ret = unsafe { nix::libc::poll(&mut pfd, 1, 0) };
    // ... also ioctl(FIONREAD) ...
}
```

**Result (all stalls):**
```
poll_ret=0  revents=0x0     ← NO events, peer is ALIVE (no POLLHUP)
FIONREAD ioctl_ret=0 bytes=0   ← no data pending
```

**Conclusion:** The kernel definitively confirms the peer socket (main_sender) is
still alive and held open by some process. If all copies were closed, `POLLHUP`
would be set.

---

### Step 8: Expand /proc/net/unix to ALL SEQPACKET Entries

**Tool:** Broadened `/proc/net/unix` filter to include all Type `0005` entries

Previously we only showed sockets matching our inodes. Changed to also show all
SEQPACKET sockets:

```rust
if line.contains(" 0005 ")
    || socket_inodes.iter().any(|ino| line.contains(ino))
```

**Result:** Now shows 6 SEQPACKET entries instead of 4:
```
Inode  RefCount  Notes
1244   00000003  ← NEW! Peer socket (main_sender), not in our fd table
1245   00000003  ← Our blocked main_receiver
1246   00000003  ← NEW! Peer socket (inter_sender), not in our fd table
1247   00000003
1248   00000003
1249   00000003
```

**Conclusion:** The peer sockets (inodes 1244, 1246) are alive in the system but
not in our process's fd table. Some other process holds them open.

---

### Step 9: Scan ALL Processes' fd Tables for Socket Holders

**Tool:** `/proc/<pid>/fd/` readlink scan across all PIDs

Added a scan of every process's fd directory:

```rust
if let Ok(proc_entries) = std::fs::read_dir("/proc") {
    for pe in proc_entries.flatten() {
        // ... for each numeric PID ...
        let fd_dir = pe.path().join("fd");
        if let Ok(fd_entries) = std::fs::read_dir(&fd_dir) {
            for fe in fd_entries.flatten() {
                if let Ok(link) = std::fs::read_link(fe.path()) {
                    if link starts with "socket:[" {
                        eprintln!("pid={} fd={} -> {}", pid, fd_name, link);
                    }
                }
            }
        }
    }
}
```

**Result (breakthrough):**
```
pid=212 fd=24 -> socket:[1245]    ← Our blocked main_receiver
pid=212 fd=26 -> socket:[1247]
pid=212 fd=27 -> socket:[1248]
pid=212 fd=28 -> socket:[1249]

pid=248 fd=22 -> socket:[1244]    ← EXTRA! main_sender peer
pid=248 fd=23 -> socket:[1245]
pid=248 fd=24 -> socket:[1246]    ← EXTRA! inter_sender peer
pid=248 fd=25 -> socket:[1247]
pid=248 fd=26 -> socket:[1248]
pid=248 fd=27 -> socket:[1249]
```

**Conclusion:** **PID 248 holds copies of the sender-side sockets (1244, 1246)
that the parent closed.** These are inherited fd copies from `clone3()`. PID 248
is the intermediate child process that never closed them — because it never
progressed past its initial setup.

---

### Step 10: Identify the Stuck Child Process

**Tool:** `/proc/<pid>/comm`, `/proc/<pid>/stat`, `/proc/<pid>/wchan`,
`/proc/<pid>/syscall`, `/proc/<pid>/stack`

Enhanced the process scan to dump full state for all userspace processes
(filtering out kernel threads by ppid=0 or ppid=2):

```rust
let comm = std::fs::read_to_string(proc_dir.join("comm"));
let wchan = std::fs::read_to_string(proc_dir.join("wchan"));
let syscall = std::fs::read_to_string(proc_dir.join("syscall"));
let stack = std::fs::read_to_string(proc_dir.join("stack"));
```

**Result:**
```
USERSPACE pid=248 ppid=211 state=S comm=tokio-runtime-w
  wchan=futex_wait_queue
  syscall=98 0x16f6e68 0x80 0xffffffff80000002
  stack:
    futex_wait_queue+0x6c/0x98
    __futex_wait+0xb4/0x12c
    futex_wait+0x64/0xcc
    do_futex+0xf8/0x1a0
    __arm64_sys_futex+0xd0/0x14c
    invoke_syscall+0x48/0x10c
```

**Key findings:**
- PID 248 is a child of the guest agent (ppid=211)
- `comm=tokio-runtime-w` — inherited thread name from the tokio worker that forked
- Stuck in `futex_wait_queue` — waiting on a userspace futex at address `0x16f6e68`
- Syscall args: `futex(0x16f6e68, FUTEX_WAIT_PRIVATE, 0x80000002)`
  - `FUTEX_WAIT_PRIVATE` = in-process futex (not cross-process)
  - `0x80000002` = locked + contended (NPTL mutex encoding)

**Conclusion:** The intermediate child process is **deadlocked on a userspace mutex**.
It inherited a locked mutex from the parent's multi-threaded address space, but the
thread that held the lock does not exist in the child. Classic fork-in-multithreaded
-process problem.

---

### Step 11: Resolve the Futex Address to a Symbol

**Tool:** `llvm-nm` on the statically linked guest binary

```bash
$ llvm-nm --numeric-sort \
    target/aarch64-unknown-linux-musl/debug/boxlite-guest \
  | grep -B5 -A5 16f6e68

00000000016f6de8 B __libc
00000000016f6e50 B __hwcap
00000000016f6e58 B __eintr_valid_flag
00000000016f6e5c B __thread_list_lock
00000000016f6e60 B __abort_lock
00000000016f6e68 B __malloc_lock          ← EXACT MATCH
00000000016f6e6c B __malloc_replaced
00000000016f6e70 B __aligned_alloc_replaced
00000000016f6e78 B __bss_end__
```

**Conclusion:** The futex at `0x16f6e68` is **`__malloc_lock`** — musl libc's global
heap allocator mutex. The intermediate process deadlocks on its very first
`malloc()` call because `__malloc_lock` was held by another tokio thread at fork
time, and musl has no `pthread_atfork` handler to reset it in the child.

---

### Step 12: Confirm the Mechanism

**Understanding:** The mutex is NOT shared across processes. `clone3()` **copies**
the entire address space into the child. The child gets a snapshot of the mutex in
its locked state, but the thread that held it (Thread B) does not exist in the child:

```
BEFORE clone3():

  Parent process memory:
  ┌─────────────────────────────────────┐
  │  0x16f6e68 (__malloc_lock) = LOCKED │ ← held by Thread B
  └─────────────────────────────────────┘
       Thread A         Thread B
       (calls clone3)   (doing malloc)

AFTER clone3():

  Parent (unchanged)          Child (COPY of parent memory)
  ┌───────────────────┐      ┌───────────────────┐
  │ __malloc_lock=LOCKED│      │ __malloc_lock=LOCKED│
  │ Thread B exists ✓  │      │ Thread B GONE ✗    │
  │ → will unlock      │      │ → stuck forever    │
  └───────────────────┘      └───────────────────┘
```

**Why `__malloc_lock` is the worst possible lock to inherit:** It is impossible
to avoid. The intermediate process cannot execute literally any useful code
without allocating memory. Even `Vec::new()`, `String::from()`, `format!()`, or
`PathBuf` operations call `malloc()`, which tries to acquire `__malloc_lock`.

---

## Environment Details

| Component       | Detail                                           |
|-----------------|--------------------------------------------------|
| Platform        | macOS ARM64 (Apple Silicon), VM via libkrun       |
| Guest kernel    | Linux aarch64                                    |
| Guest binary    | `boxlite-guest`, statically linked, musl libc    |
| Target triple   | `aarch64-unknown-linux-musl`                     |
| Runtime         | tokio multi-threaded (4 worker threads)          |
| libcontainer    | youki v0.5.7 (vendored)                          |
| Channel type    | `AF_UNIX SOCK_SEQPACKET` with `SOCK_CLOEXEC`    |

## libcontainer Channel Architecture

```
container_main_process() creates 3 channel pairs (6 SEQPACKET sockets):

  Parent side        Peer (child side)     Purpose
  ─────────────────────────────────────────────────────────────
  main_receiver  ←→  main_sender          children → parent readiness
  inter_sender   ←→  inter_receiver       parent → intermediate config
  init_sender    ←→  init_receiver        parent → init config

Fork lifecycle:
  1. Parent creates all 3 pairs (6 fds)
  2. clone3() → intermediate (inherits ALL 6 fds as copies)
  3. Parent closes main_sender, inter_sender (2 fds)
  4. Parent calls main_receiver.recv() — waits for intermediate_ready
  5. Intermediate should: setup → send intermediate_ready → fork init → exit
  6. Init should: setup → send init_ready → exec() (CLOEXEC closes channel fds)

When intermediate deadlocks at step 5:
  - Intermediate's copy of main_sender stays open
  - Parent's recv() never gets EOF (peer alive)
  - Parent blocks forever
```

## Test Results Summary

| Batch   | Runs | Stalls | Stall Rate |
|---------|------|--------|------------|
| Batch 1 | 8    | 3      | 37.5%      |
| Batch 2 | 8    | 3      | 37.5%      |
| Batch 3 | 10   | 4      | 40.0%      |
| Batch 4 | 12   | 1      | 8.3%       |
| **Total** | **38** | **11** | **28.9%** |

## Diagnostic Techniques Reference

| Technique | Source | What it reveals |
|-----------|--------|-----------------|
| `/proc/self/task/<tid>/wchan` | procfs | Kernel wait channel name |
| `/proc/self/task/<tid>/syscall` | procfs | Blocked syscall number + register args |
| `/proc/self/fd/<N>` readlink | procfs | fd → inode mapping (`socket:[NNNN]`) |
| `/proc/net/unix` | procfs | Unix socket state, RefCount, Type, Inode |
| `/proc/<pid>/fd/` cross-scan | procfs | Find which process holds specific sockets |
| `/proc/<pid>/stack` | procfs | Kernel stack trace of a stuck process |
| `/proc/<pid>/comm` | procfs | Process/thread name |
| `poll(fd, POLLIN\|POLLHUP, 0)` | syscall | Peer socket liveness (POLLHUP = peer dead) |
| `ioctl(fd, FIONREAD)` | syscall | Bytes pending in socket recv buffer |
| `llvm-nm --numeric-sort` | toolchain | Resolve address to symbol in static binary |

## Files Read During Investigation

```
guest/src/container/command.rs                                    (MODIFIED — watchdog)
guest/src/service/exec/executor.rs                                (ContainerExecutor::spawn)
guest/src/service/exec/mod.rs
libcontainer/src/channel.rs                                       (base channel, socketpair)
libcontainer/src/process/channel.rs                               (Main/Inter/Init channels)
libcontainer/src/process/container_main_process.rs                (fork + channel lifecycle)
libcontainer/src/process/container_intermediate_process.rs        (intermediate setup)
libcontainer/src/process/fork.rs                                  (clone3, CLONE_PARENT)
libcontainer/src/container/tenant_builder.rs                      (build() entry point)
libcontainer/src/container/builder_impl.rs                        (run_container, NotifyListener)
libcontainer/src/notify_socket.rs                                 (dangerous Clone impl)
```
