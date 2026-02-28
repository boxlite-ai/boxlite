# BoxLite Boot Latency Analysis

**Date:** 2025-02-22
**Scope:** `handle.start()` latency on macOS ARM64 (Apple Silicon)
**Test:** `boxlite/tests/timing_profile.rs` with `alpine:latest` image

## Executive Summary

`handle.start()` takes **~2.1s with jailer** vs **~0.7s without jailer**. The
1.4s difference is **not caused by sandbox-exec** (which adds only ~5ms). The
root cause is **macOS kernel per-page code signing validation** for freshly
copied dylibs — an unavoidable kernel-level cost when executing binaries from
new inodes.

## Full Boot Timeline (Jailer ON)

```
Time (wall)         Event                               Delta
─────────────────────────────────────────────────────────────────
02:37:19.077        handle.start() called
02:37:19.320        [host] shim spawned (took 4ms)       +243ms  pipeline setup
                    ┌─── 1000ms gap ──────────────────┐
                    │  sandbox-exec policy parse  ~10ms│
                    │  exec(shim)                  ~5ms│
                    │  dyld: code sign validation ~985ms│  ← 20.7MB of dylibs
                    └─────────────────────────────────┘
02:37:20.321        [shim] T+0ms:  main() entered
02:37:20.321        [shim] T+0ms:  config parsed
02:37:20.323        [shim] T+2ms:  logging initialized
02:37:20.328        [shim] T+7ms:  gvproxy created
02:37:20.328        [shim] T+7ms:  engine created
                    ┌─── 443ms ───────────────────────┐
                    │  dlopen(libkrunfw.5.dylib) 22MB  │  ← code sign validation
                    │  krun FFI: ctx_create, configure │
                    └─────────────────────────────────┘
02:37:20.771        [shim] T+450ms: krun_start_enter called
                    ┌─── 286ms ───────────────────────┐
                    │  VM kernel boot                  │
                    │  Guest agent startup             │
                    │  vsock ready notification        │
                    └─────────────────────────────────┘
02:37:21.057        [host] guest_connect: accept
02:37:21.143        handle.start() returns               total: 2067ms
```

## Latency Breakdown

| Phase | Duration | % of Total | Root Cause |
|-------|----------|------------|------------|
| Pipeline setup | 244ms | 12% | image_prepare (237ms) + rootfs (7ms) |
| spawn to main() | **1000ms** | **48%** | Code signing: shim + libkrun + libgvproxy |
| krun FFI | **450ms** | **22%** | Code signing: dlopen(libkrunfw 22MB) |
| VM boot + guest | 286ms | 14% | Kernel boot + guest agent + vsock notify |
| Container init | 86ms | 4% | gRPC call to guest for OCI setup |

**Code signing validation accounts for ~1450ms (70%) of boot time.**

## Root Cause: macOS Kernel Code Signing Page Validation

### Mechanism

The jailer copies shim + dylibs (~36MB) to each box's directory, creating new
inodes (even with APFS reflink/CoW). On macOS, when `dyld` loads an executable
via `mmap()`, the kernel validates the ad-hoc code signature **per page**:

1. `dyld` maps each library's `__TEXT` segment via `mmap(MAP_PRIVATE)`
2. On each first page fault, the kernel:
   - Reads page content (4KB on x86, 16KB on ARM)
   - Computes SHA-256 hash
   - Compares against the embedded `CodeDirectory` hash slot
3. Result is cached **per inode** — subsequent runs of the same inode are fast

For 20.7MB of pre-main dylibs, this means ~1,300 page validations at ~0.77ms
each = ~1000ms.

### Evidence

All measurements use the same shim binary (5.4MB) + dylibs (libkrun 4.4MB,
libgvproxy 10.9MB = 20.7MB total), varying only copy freshness and sandbox:

| Scenario | Startup (ms) | Notes |
|----------|-------------|-------|
| Original binary, no sandbox | 13 | dyld shared cache warm |
| **Cold copy, no sandbox** | **850** | New inode, full validation |
| Warm copy, no sandbox | 10 | Kernel cache populated |
| Warm copy + sandbox | 14 | **Sandbox adds only +4ms** |
| Cold copy, `cat` prewarm | 830 | File I/O cache != mmap cache |
| Cold copy, `codesign --verify` | 850 | Userspace != kernel cache |
| Cold copy, first exec warmup | **34** | dyld mmap warms kernel cache |

### Key Findings

1. **sandbox-exec is NOT the bottleneck** — policy compilation takes ~10ms
   regardless of complexity (tested with 5 to 200 rules: identical latency)

2. **`cat` prewarm does NOT help** — file I/O populates the buffer cache, but
   dyld's `mmap()` uses the kernel's code signing pager, which is a separate
   cache path

3. **`codesign --verify` does NOT help** — it validates from userspace using
   its own file reads, but the kernel maintains its own validation cache
   populated only through the mmap pager

4. **Only executing the binary warms the cache** — the kernel's code signing
   validation cache is populated exclusively when dyld maps executable pages
   via `mmap()`

## Comparison: Jailer ON vs OFF

| Metric | Jailer ON | Jailer OFF | Delta |
|--------|-----------|------------|-------|
| handle.start() | 2067ms | 696ms | +1371ms |
| spawn to main gap | 1000ms | 10ms | +990ms |
| krun FFI (engine.create) | 450ms | 23ms | +427ms |
| sandbox-exec overhead | ~5ms | N/A | ~5ms |

The ~1417ms difference is almost entirely code signing validation (990 + 427).
The sandbox policy overhead is negligible.

## Pipeline Stage Metrics (from handle.metrics())

| Stage | Jailer ON | Jailer OFF |
|-------|-----------|------------|
| total_create_duration | 2039ms | 695ms |
| stage_filesystem_setup | 0ms | -- |
| stage_image_prepare | 237ms | -- |
| stage_guest_rootfs | 7ms | -- |
| stage_box_spawn | 12ms | 11ms |
| stage_container_init | 86ms | 63ms |
| guest_connect (computed) | ~1697ms | ~621ms |

## Potential Mitigations

### High Impact

1. **Shared bin/ directory** — Copy dylibs once to a shared location
   (`~/.boxlite/bin/`) instead of per-box. Code signing cache is per-inode, so
   one copy = one validation amortized across all boxes. First box pays the
   cost; subsequent boxes start in ~14ms.
   - **Estimated savings: ~1400ms for 2nd+ box starts**
   - Trade-off: Reduces memory isolation between boxes (shared `.text` pages)

2. **Static linking** — Link libkrun + libgvproxy statically into
   boxlite-shim. Single binary (~25MB) = single code signing pass instead of
   4 separate ones. Eliminates dyld overhead entirely.
   - **Estimated savings: ~200ms** (fewer mmap operations, no dlopen)
   - Trade-off: Larger binary, harder to update individual components

3. **Pre-exec warmup** — After copying, run the shim in a no-op mode
   (`--warmup` flag that exits after dyld loads) to populate the kernel cache.
   - **Estimated savings: ~990ms on subsequent start**
   - Trade-off: Adds ~850ms to `create()` time instead of `start()` time

### Medium Impact

4. **Skip copy for ephemeral boxes** — If `auto_remove=true`, use the original
   binary directly (no copy needed since box won't persist).
   - **Estimated savings: ~1400ms for ephemeral boxes**
   - Trade-off: Weaker isolation for ephemeral boxes

5. **Reduce dylib sizes** — Strip debug symbols, enable LTO for libkrun and
   libgvproxy. Current sizes: libkrunfw 22MB, libgvproxy 10.9MB, libkrun
   4.4MB, shim 5.4MB.
   - **Estimated savings: proportional to size reduction**

### Low Impact (Confirmed NOT Effective)

- ~~Simplify seatbelt policy~~ — Policy complexity has zero impact on startup
- ~~Pre-warm with `cat`~~ — Wrong cache path, doesn't help
- ~~Pre-warm with `codesign --verify`~~ — Userspace validation, doesn't help
- ~~Reduce FD cleanup range~~ — Only 0.9ms for 4092 close() calls

## Instrumentation Added

The following `eprintln!` instrumentation was added during this investigation:

| File | Line | Tag | Measures |
|------|------|-----|----------|
| `vmm/controller/shim.rs` | 335 | `[host]` | shim spawn wall clock + duration |
| `bin/shim/main.rs` | 86 | `[shim]` | main() entry wall clock + T+offset |
| `bin/shim/main.rs` | 95-276 | `[shim]` | config parse, gvproxy, engine, krun |
| `vmm/krun/context.rs` | 551 | `[krun]` | krun_start_enter call + return |
| `litebox/init/tasks/guest_connect.rs` | 138 | `[host]` | socket bind + accept |

## Methodology

1. Added `eprintln!` timestamps with `chrono::Utc::now()` at key points in
   both host and shim processes for wall-clock correlation
2. Created `timing_profile.rs` integration test with jailer ON/OFF variants
3. Built standalone C/bash benchmarks to isolate individual variables:
   - sandbox-exec policy compilation time (10ms, independent of complexity)
   - FD cleanup time (0.9ms for 4092 close() calls)
   - Cold vs warm binary startup (850ms vs 10ms)
   - Various pre-warm strategies (cat, codesign, first-exec)
4. All measurements on Apple Silicon (M-series), APFS filesystem

## Reproduction

```bash
# Rebuild shim with instrumentation
./scripts/build/build-shim.sh

# Run timing profile tests
cargo test -p boxlite --test timing_profile -- --nocapture

# Run jailer-only test (no parallel contention)
cargo test -p boxlite --test timing_profile boot_timing_profile \
  -- --exact --nocapture
```
