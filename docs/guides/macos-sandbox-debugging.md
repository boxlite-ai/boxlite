# Debugging macOS Sandbox (Seatbelt) Denials

This guide explains how to debug sandbox policy issues when developing or troubleshooting BoxLite's macOS sandbox isolation.

## Overview

BoxLite uses macOS's built-in sandbox system (Seatbelt) to isolate the `boxlite-shim` process. The sandbox uses SBPL (Sandbox Profile Language) policies that whitelist specific operations. When an operation is denied, macOS logs the denial to the system log.

## Quick Reference

```bash
# Real-time monitoring (recommended during development)
log stream --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "boxlite"'

# Check recent denials (last 5 minutes)
log show --last 5m --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"'
```

## Debugging Workflow

### Step 1: Enable Real-time Log Monitoring

Open a separate terminal and start monitoring sandbox messages:

```bash
# Watch all sandbox denials
log stream --predicate 'subsystem == "com.apple.sandbox"' --level error

# Or filter for boxlite specifically
log stream --predicate 'eventMessage CONTAINS "boxlite-shim" AND eventMessage CONTAINS "deny"'
```

### Step 2: Run Your Test

In another terminal, run the operation that's failing:

```bash
source .venv/bin/activate
python -c "
import asyncio
import boxlite

async def test():
    async with boxlite.SimpleBox(image='alpine:latest') as box:
        result = await box.exec('echo', 'hello')
        print(result.stdout)

asyncio.run(test())
"
```

### Step 3: Analyze Denials

Sandbox denials appear in the format:

```
kernel: (Sandbox) Sandbox: boxlite-shim(PID) deny(1) OPERATION TARGET
```

Common denial types:

| Operation | Target | Meaning |
|-----------|--------|---------|
| `file-read-data` | `/path/to/file` | Process tried to read file contents |
| `file-read-metadata` | `/path` | Process tried to stat/access file metadata |
| `file-write-data` | `/path/to/file` | Process tried to write to file |
| `file-write-create` | `/path/to/file` | Process tried to create new file |
| `sysctl-read` | `kern.bootargs` | Process tried to read sysctl value |
| `mach-lookup` | `com.apple.service` | Process tried to connect to mach service |
| `network-outbound` | `*:443` | Process tried to make network connection |
| `iokit-open` | `IOHIDFamily` | Process tried to access IOKit device |

### Step 4: Update the Policy

Based on the denial, add the appropriate rule to the SBPL policy:

```scheme
; For file-read-data /var
(allow file-read* (literal "/var"))

; For sysctl-read kern.bootargs
(allow sysctl-read (sysctl-name "kern.bootargs"))

; For mach-lookup com.apple.service
(allow mach-lookup (global-name "com.apple.service"))
```

### Step 5: Rebuild and Test

After updating `.sbpl` files, rebuild to pick up changes:

```bash
# The .sbpl files are embedded via include_str!
# Touch the Rust file to force recompilation
make dev:python

# Or for just the Rust library
cargo clean -p boxlite && cargo build -p boxlite
```

## Log Commands Reference

### Real-time Streaming

```bash
# All sandbox messages
log stream --predicate 'subsystem == "com.apple.sandbox"'

# Only errors (denials)
log stream --predicate 'subsystem == "com.apple.sandbox"' --level error

# Specific process
log stream --predicate 'eventMessage CONTAINS "boxlite-shim"'

# Combined: boxlite denials only
log stream --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "boxlite" AND eventMessage CONTAINS "deny"'
```

### Historical Queries

```bash
# Last N minutes
log show --last 5m --predicate 'eventMessage CONTAINS "Sandbox:"'

# Time range
log show --start "2024-01-06 10:00:00" --end "2024-01-06 10:05:00" --predicate 'subsystem == "com.apple.sandbox"'

# Count denials by type
log show --last 10m --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"' | grep -oE 'deny\(1\) [^ ]+' | sort | uniq -c | sort -rn
```

### Filtering Tips

```bash
# Exclude noisy system processes
log show --last 5m --predicate 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny" AND NOT eventMessage CONTAINS "imagent" AND NOT eventMessage CONTAINS "bluetoothd"'

# Only kernel messages (most reliable)
log show --last 5m --predicate 'senderImagePath == "/kernel" AND eventMessage CONTAINS "Sandbox:"'
```

## SBPL Policy Syntax

### Basic Structure

```scheme
(version 1)

; Deny everything by default
(deny default)

; Allow specific operations
(allow process-exec)
(allow file-read* (subpath "/usr/lib"))
(allow sysctl-read (sysctl-name "hw.ncpu"))
```

### Common Patterns

```scheme
; Allow reading entire directory tree
(allow file-read* (subpath "/path/to/dir"))

; Allow reading single file only
(allow file-read* (literal "/path/to/file"))

; Allow reading files matching pattern
(allow file-read* (regex #"^/Users/[^/]+/\.boxlite/"))

; Allow multiple sysctls
(allow sysctl-read
    (sysctl-name "hw.ncpu")
    (sysctl-name "hw.memsize")
    (sysctl-name-prefix "kern.proc."))

; Allow mach service lookup
(allow mach-lookup
    (global-name "com.apple.CoreServices.coreservicesd")
    (global-name "com.apple.system.logger"))
```

### Testing Syntax

```bash
# Test if policy syntax is valid
sandbox-exec -p '(version 1)(deny default)(allow process-exec)' /bin/echo "Policy OK"

# Test with a file
sandbox-exec -f /path/to/policy.sbpl /bin/echo "Policy OK"
```

## BoxLite Policy Files

BoxLite's sandbox policy is split into multiple files:

| File | Purpose |
|------|---------|
| `seatbelt_base_policy.sbpl` | Process ops, sysctls, mach services, IOKit |
| `seatbelt_file_read_policy.sbpl` | Static system paths for reading |
| `seatbelt_file_write_policy.sbpl` | Static paths for writing (/tmp) |
| `seatbelt_network_policy.sbpl` | Network access (optional) |
| `macos.rs` | Dynamic paths (binary, volumes, box_dir) |

### Viewing Generated Policy

To see the complete generated policy:

```rust
// In Rust code
use boxlite::jailer::{SecurityOptions, write_sandbox_profile};

let security = SecurityOptions::default();
let box_dir = Path::new("/tmp/test-box");
let binary_path = Path::new("/path/to/boxlite-shim");

write_sandbox_profile(
    Path::new("/tmp/debug-policy.sbpl"),
    &security,
    box_dir,
    binary_path,
).unwrap();
```

Then inspect `/tmp/debug-policy.sbpl`.

## Common Issues

### 1. Changes Not Taking Effect

The `.sbpl` files are embedded at compile time via `include_str!`. After modifying them:

```bash
# Force recompilation
cargo clean -p boxlite
cargo build -p boxlite

# For Python SDK
make dev:python
```

### 2. Path Canonicalization

macOS uses symlinks (`/var` -> `/private/var`, `/tmp` -> `/private/tmp`). Use canonical paths:

```scheme
; Wrong - /tmp is a symlink
(allow file-write* (subpath "/tmp"))

; Correct - use canonical path
(allow file-write* (subpath "/private/tmp"))
```

### 3. Duplicate Denials

The log may show "X duplicate reports for...". This means the same denial happened multiple times. Fix the root cause, not each duplicate.

### 4. Silent Failures

Some denials don't appear in logs immediately. If the process hangs or crashes without logged denials:

1. Check for crash reports: `ls ~/Library/Logs/DiagnosticReports/*shim*`
2. Ensure process actually started: check host logs
3. Try running without sandbox to isolate the issue

### 5. Permissions vs Sandbox

Not all failures are sandbox-related. Check:
- File permissions (`ls -la`)
- Directory existence
- Hypervisor.framework entitlements

## Debugging Checklist

- [ ] Start log streaming before running test
- [ ] Filter logs for your process name
- [ ] Check for `deny(1)` messages
- [ ] Note the exact operation and target
- [ ] Add minimal rule to policy (prefer `literal` over `subpath`)
- [ ] Document WHY the rule is needed (in comments)
- [ ] Rebuild and retest
- [ ] Verify no new denials appear

## Further Reading

- [Apple Sandbox Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/AppSandboxDesignGuide/)
- [SBPL Reference (reverse-engineered)](https://reverse.put.as/wp-content/uploads/2011/09/Apple-Sandbox-Guide-v1.0.pdf)
- [Chromium macOS Sandbox](https://chromium.googlesource.com/chromium/src/+/main/sandbox/mac/)
