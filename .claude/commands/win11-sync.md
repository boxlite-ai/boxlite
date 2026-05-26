# Win11 Sync

Pack ALL modified source files (vs main branch), generate a rebuild+test .bat script, and deploy everything to Win11 (T14).

## Environment

- **SSH**: `ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221`
- **Workspace**: `D:\ws-boxlite\` (working dir), `D:\ws-boxlite\boxlite\` (source)
- **Runtime**: `D:\ws-boxlite\runtime\`
- **Proxy**: `HTTP_PROXY=http://127.0.0.1:7897`
- **SCP path format**: Forward slashes only: `"t14@192.168.3.221:D:/ws-boxlite/file.txt"`

## Steps

### 1. Identify ALL Modified Files vs Main

**CRITICAL**: Use `git diff main` (not `git diff`). This captures ALL branch changes including committed changes from previous iterations — not just unstaged changes in the current session.

```bash
# ALL src/ files changed on this branch vs main
git diff main --name-only -- src/ > /tmp/win11-sync-files.txt

# Also include any unstaged changes not yet committed
git diff --name-only -- src/ >> /tmp/win11-sync-files.txt

# Deduplicate
sort -u /tmp/win11-sync-files.txt -o /tmp/win11-sync-files.txt

# Show count and list
echo "=== Files to sync: $(wc -l < /tmp/win11-sync-files.txt) ==="
cat /tmp/win11-sync-files.txt
```

Only include `src/` files. Skip docs, scripts, .claude, etc.

### 2. Analyze What Changed (for cache/rebuild decisions)

Run this ONCE and note the results — they drive Steps 4's .bat generation:

```bash
FILES=$(cat /tmp/win11-sync-files.txt)

# Check: need disk-images cache clear?
NEED_DISK_CACHE_CLEAR=false
echo "$FILES" | grep -qE "(image_disk\.rs|disk/ext4\.rs|disk/constants\.rs)" && NEED_DISK_CACHE_CLEAR=true

# Check: need cargo clean? (any Rust src changed = yes, since linker caches)
NEED_CARGO_CLEAN=false
echo "$FILES" | grep -qE "\.rs$" && NEED_CARGO_CLEAN=true

# Check: need libgvproxy cross-compile?
NEED_GVPROXY=false
echo "$FILES" | grep -q "libgvproxy-sys/gvproxy-bridge/" && NEED_GVPROXY=true

# Check: VMM files changed? (libkrun submodule)
VMM_CHANGED=false
echo "$FILES" | grep -q "libkrun-sys/vendor/libkrun/src/vmm/" && VMM_CHANGED=true

echo "disk-images cache clear: $NEED_DISK_CACHE_CLEAR"
echo "cargo clean: $NEED_CARGO_CLEAN"
echo "libgvproxy cross-compile: $NEED_GVPROXY"
echo "VMM files changed: $VMM_CHANGED"
```

### 3. Cross-compile libgvproxy (only if gvproxy sources changed)

If `NEED_GVPROXY=true`:

```bash
bash scripts/build/cross-compile-gvproxy-windows.sh
```

Output: `target/kernel-windows-x86_64/libgvproxy.lib` (31MB). Skip if only Rust files changed.

### 4. Create Sync Tarball

Increment N from previous sync (check `/tmp/boxlite-sync*.tar.gz`):

```bash
tar czf /tmp/boxlite-syncN.tar.gz -T /tmp/win11-sync-files.txt
echo "Tarball: $(ls -lh /tmp/boxlite-syncN.tar.gz)"
echo "File count: $(tar tzf /tmp/boxlite-syncN.tar.gz | wc -l)"
```

**Verification**: The file count must match the count from Step 1. If they differ, investigate.

### 5. Generate .bat Script

Write `/tmp/win11-e2eN.bat` with the sections below. The cache clearing and cargo clean lines are **deterministic** based on Step 2 analysis.

**CRITICAL rules**:
- One `set` per line (no `&&` after `set`)
- Use `cd /d` for drive switching
- `RUST_LOG=info` (NEVER debug — debug kills WHPX networking)
- Always `cargo clean` when Rust source files changed

```bat
@echo off
cd /d D:\ws-boxlite\boxlite
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set PATH=D:\ws-boxlite\tools\protoc\bin;%PATH%

echo === Kill old processes ===
taskkill /F /IM boxlite-shim.exe 2>nul

echo === Extract updated files ===
cd /d D:\ws-boxlite
tar xzf boxlite-syncN.tar.gz -C boxlite\
echo Extract OK

echo === Verify sync completeness ===
echo Expected: <FILE_COUNT> files
REM Pick 2-3 key files from different directories to verify:
findstr /C:"UNIQUE_STRING_1" boxlite\path\to\file1
findstr /C:"UNIQUE_STRING_2" boxlite\path\to\file2
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Sync incomplete!
    exit /b 1
)

echo === Clear caches ===
if exist "%USERPROFILE%\.boxlite\boxes" (rmdir /S /Q "%USERPROFILE%\.boxlite\boxes")
REM --- ONLY if NEED_DISK_CACHE_CLEAR=true (image_disk.rs or ext4.rs changed): ---
if exist "%USERPROFILE%\.boxlite\images\disk-images" (rmdir /S /Q "%USERPROFILE%\.boxlite\images\disk-images")
REM --- Remove the line above if NEED_DISK_CACHE_CLEAR=false ---

echo === Cargo clean ===
cd /d D:\ws-boxlite\boxlite
set LIBGVPROXY_PREBUILT=D:\ws-boxlite\runtime\gvproxy.lib
cargo clean 2>&1
echo === Clean done ===

echo === Rebuild shim ===
cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun,gvproxy 2>&1
if %ERRORLEVEL% NEQ 0 (echo SHIM BUILD FAILED && exit /b %ERRORLEVEL%)
copy /Y target\debug\boxlite-shim.exe D:\ws-boxlite\runtime\boxlite-shim.exe
echo === Shim OK ===

echo === Rebuild SDK ===
set BOXLITE_DEPS_STUB=1
cd /d D:\ws-boxlite\boxlite\sdks\python
pip install -e . 2>&1
if %ERRORLEVEL% NEQ 0 (echo SDK BUILD FAILED && exit /b %ERRORLEVEL%)
set BOXLITE_DEPS_STUB=
echo === SDK OK ===

echo === Run vm-bench ===
cd /d D:\ws-boxlite
set BOXLITE_RUNTIME_DIR=D:\ws-boxlite\runtime
set RUST_LOG=info
python vm-bench.py > e2e-testN.txt 2>&1

echo === vm-bench Summary ===
findstr /C:"import" /C:"runtime_init" /C:"box_create" /C:"exec" /C:"stop" /C:"remove" /C:"Error" /C:"Grand" e2e-testN.txt

echo === Run net-test ===
python net-test.py > net-testN.txt 2>&1

echo === net-test Summary ===
findstr /C:"PASS" /C:"FAIL" /C:"Error" /C:"Grand" net-testN.txt

echo === DONE ===
```

### 6. SCP Tarball + .bat + libgvproxy.lib to Win11

```bash
# Convert .bat to CRLF
perl -pe 's/\n/\r\n/' /tmp/win11-e2eN.bat > /tmp/win11-e2eN-crlf.bat
mv /tmp/win11-e2eN-crlf.bat /tmp/win11-e2eN.bat

# SCP
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-syncN.tar.gz /tmp/win11-e2eN.bat t14@192.168.3.221:"D:/ws-boxlite/"
```

If libgvproxy.lib was cross-compiled (step 3), also SCP it:

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa target/kernel-windows-x86_64/libgvproxy.lib t14@192.168.3.221:"D:/ws-boxlite/runtime/"
```

### 7. Verify Deployment

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "dir D:\\ws-boxlite\\boxlite-syncN.tar.gz D:\\ws-boxlite\\win11-e2eN.bat"
```

Both files must exist with non-zero size.

## Automatic Cache Clearing Rules

These are DETERMINISTIC — apply them based on Step 2 analysis:

| Condition | Action |
|-----------|--------|
| ANY `.rs` file changed | `cargo clean` (linker caches stale objects) |
| `image_disk.rs` or `disk/ext4.rs` or `disk/constants.rs` changed | Clear `disk-images/` cache |
| `image_disk.rs` changed | Also verify with `findstr /C:"has_non_ascii"` in .bat |
| Always | Clear `boxes/` cache (safe, forces clean box creation) |

## Rebuild Rules

Both shim and SDK are ALWAYS rebuilt after `cargo clean`. No selective rebuild logic needed.
