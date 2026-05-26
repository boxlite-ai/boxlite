# Win10 Python SDK Testing Guide

Best practices and step-by-step guide for testing the BoxLite Python SDK on Windows 10 with WHPX.

**Last updated:** 2026-04-19

---

## Environment Prerequisites

### Hardware
- x86_64 CPU with hardware virtualization (Intel VT-x)
- WHPX (Windows Hypervisor Platform) enabled in Windows Features
- At least 4 GB RAM free

### Software
| Component | Version | Location | Notes |
|-----------|---------|----------|-------|
| Python | 3.12.8 | `C:\Users\<user>\AppData\Local\Programs\Python\Python312\python.exe` | **Must use `python`, NOT `python3`** (Windows convention) |
| Rust | stable 1.94.0+ | `%USERPROFILE%\.cargo\bin\` | `rustup` installed |
| maturin | 1.13.1+ | `pip install maturin` | PyO3 build tool |
| protoc | 3.x | `C:\ws-boxlite\tools\protoc\bin\protoc.exe` | gRPC proto compilation |
| Git | 2.x | System PATH | Submodule support needed |

### Runtime Binaries (in `C:\ws-boxlite\runtime\`)
| Binary | Source | Notes |
|--------|--------|-------|
| `vmlinuz` | Alpine linux-virt 6.12.81 x86_64 | Kernel image (~11.7 MB) |
| `initrd.img` | Custom (see Initramfs section) | virtio_blk + vsock modules |
| `boxlite-guest` | Cross-compiled from `src/guest/` | x86_64-unknown-linux-musl static |
| `boxlite-shim.exe` | Built from `cargo build -p boxlite --bin boxlite-shim` | ~7 MB |
| `mke2fs.exe` | Cross-compiled e2fsprogs | ext4 filesystem creation |
| `debugfs.exe` | Cross-compiled e2fsprogs | ext4 file injection |

### Network Proxy (if behind firewall)
```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
```

---

## Environment Variables

These MUST be set before any build or test:

```powershell
$env:BOXLITE_DEPS_STUB = "1"                              # Skip native libkrun/e2fsprogs builds
$env:PROTOC = "C:\ws-boxlite\tools\protoc\bin\protoc.exe"  # protobuf compiler
$env:HTTP_PROXY = "http://127.0.0.1:7897"                  # Proxy (if needed)
$env:HTTPS_PROXY = "http://127.0.0.1:7897"                 # Proxy (if needed)
$env:RUST_LOG = "info"                                      # Logging level for tests
```

**CRITICAL:** `BOXLITE_DEPS_STUB=1` is required because the native C library builds (libkrun, e2fsprogs) are not supported in the Windows build environment. The Rust code compiles with stub FFI bindings instead.

---

## Build Procedures

### Step 1: Build the Python SDK

```powershell
cd C:\ws-boxlite\boxlite\sdks\python
pip install -e .
```

**Key learnings:**
- `pip install -e .` invokes `maturin` (configured in `pyproject.toml`) and builds the PyO3 extension
- First build takes ~80-90s (compiles the entire boxlite Rust crate)
- Incremental rebuilds take ~10-20s
- `maturin develop --interpreter python` does NOT work on maturin 1.13.1 (`--interpreter` is removed); use `pip install -e .` instead
- `maturin develop` alone may install to a virtualenv; `pip install -e .` ensures system Python gets the package

### Step 2: Verify Import

```powershell
python -c "import boxlite; print(boxlite.__version__)"
# Expected output: 0.8.2
```

**Troubleshooting:**
- `ModuleNotFoundError: No module named 'boxlite'` → re-run `pip install -e .`
- `python3` not found → use `python` (Windows convention)
- Exit code 9009 → command not found, check PATH

### Step 3: Build boxlite-shim

```powershell
# MUST kill existing processes before rebuilding
taskkill /F /IM boxlite-shim.exe 2>$null
taskkill /F /IM boot_kernel.exe 2>$null

cd C:\ws-boxlite\boxlite
cargo build -p boxlite --bin boxlite-shim

# Deploy to runtime directory
copy target\debug\boxlite-shim.exe C:\ws-boxlite\runtime\boxlite-shim.exe
```

**Key learning:** The shim binary is in the `boxlite` crate (`cargo build -p boxlite --bin boxlite-shim`), NOT a separate `boxlite-shim` package. `cargo build -p boxlite-shim` will fail with "did not match any packages".

### Step 4: Build boot_kernel (for direct VMM testing)

```powershell
cd C:\ws-boxlite\boxlite\src\deps\libkrun-sys\vendor\libkrun\src\vmm
cargo build --example boot_kernel
```

**Key learning:** The vmm crate is NOT a workspace member of the boxlite workspace. It must be built from its own directory.

---

## Test Procedures

### Test 1: Python SDK Import (Smoke Test)

```powershell
$start = Get-Date
python -c "import boxlite; print(f'version={boxlite.__version__}')"
$elapsed = ((Get-Date) - $start).TotalSeconds
Write-Host "Elapsed: ${elapsed}s"
```

Expected: version=0.8.2, <1s

### Test 2: Kernel Boot + Guest Agent

```powershell
$bootExe = "C:\ws-boxlite\boxlite\src\deps\libkrun-sys\vendor\libkrun\target\debug\examples\boot_kernel.exe"

$env:RUST_LOG = "info"
& $bootExe C:\ws-boxlite\runtime\vmlinuz C:\ws-boxlite\runtime\initrd.img `
    --disk C:\ws-boxlite\test-rootfs-x86.img `
    --root /dev/vda --fstype ext4 `
    --init /boxlite/bin/boxlite-guest `
    --argv --listen --argv vsock://2695 `
    --argv --notify --argv vsock://2696
```

Expected output includes:
```
[guest] T+0ms: agent starting
[guest] T+XXms: server bound (vsock:2695)
[guest] T+XXms: host notified (vsock:2696)
Host notified successfully
```

**Key learning:** Always redirect output to a file for remote SSH testing:
```powershell
& $bootExe ... > C:\ws-boxlite\boot_test.log 2>&1
```

### Test 3: Vsock TCP Bridge (Guest -> Host)

This verifies the VMM bridges guest vsock connections to host TCP.

```powershell
# Start TCP listener
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 9999)
$listener.Start()

# Start VM with vsock-connect (guest vsock:2696 -> host TCP:9999)
$proc = Start-Process -FilePath $bootExe -ArgumentList @(
    "C:\ws-boxlite\runtime\vmlinuz",
    "C:\ws-boxlite\runtime\initrd.img",
    "--disk", "C:\ws-boxlite\test-rootfs-x86.img",
    "--root", "/dev/vda", "--fstype", "ext4",
    "--init", "/boxlite/bin/boxlite-guest",
    "--vsock-listen", "2695:9998",
    "--vsock-connect", "2696:9999",
    "--argv", "--listen", "--argv", "vsock://2695",
    "--argv", "--notify", "--argv", "vsock://2696"
) -PassThru -NoNewWindow -RedirectStandardOutput "C:\ws-boxlite\test.log" -RedirectStandardError "C:\ws-boxlite\test_err.log"

# Wait for connection (max 15s)
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    if ($listener.Pending()) {
        $client = $listener.AcceptTcpClient()
        Write-Host "SUCCESS: Received connection!"
        $client.Close()
        break
    }
    Start-Sleep -Milliseconds 200
}

$listener.Stop()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
```

### Test 4: Vsock TCP Bridge (Host -> Guest gRPC)

Same as Test 3, but after guest starts, verify host can connect to guest gRPC via TCP bridge:

```powershell
# After guest shows "Listening on vsock://...", try:
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect("127.0.0.1", 9998)
Write-Host "gRPC bridge active: $($tcp.Connected)"
$tcp.Close()
```

### Test 5: Windows Cargo Tests

```powershell
cd C:\ws-boxlite\boxlite
cargo test -p boxlite --no-default-features --lib
```

Expected: 510 passed, 0 failed (as of 2026-04-19)

---

## Remote Testing via SSH (from macOS)

### SSH Connection
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143
```

### Key Principles

1. **Use `cmd /c` or PowerShell scripts, not chained commands**
   ```bash
   # BAD: quoting hell
   ssh ... "cmd /c \"set A=1&& set B=2&& cargo test\""

   # GOOD: deploy a .ps1 script, then execute
   scp script.ps1 remote:C:/ws-boxlite/script.ps1
   ssh ... "powershell -ExecutionPolicy Bypass -File C:\ws-boxlite\script.ps1"
   ```

2. **Output to files, then retrieve**
   ```bash
   # BAD: reading output through SSH pipe
   ssh ... "cargo test 2>&1"

   # GOOD: redirect to file, then read
   ssh ... "cargo test > C:\ws-boxlite\test.log 2>&1"
   ssh ... "type C:\ws-boxlite\test.log"
   ```

3. **Always kill before rebuild**
   ```bash
   ssh ... "taskkill /F /IM boot_kernel.exe 2>nul"
   ```

4. **Set aggressive SSH timeouts**
   ```bash
   ssh -o ConnectTimeout=10 ...
   ```

5. **`set VAR=val&&` — no trailing space before `&&`**
   ```cmd
   REM CORRECT:
   set BOXLITE_DEPS_STUB=1&& cargo test

   REM WRONG (space becomes part of value):
   set BOXLITE_DEPS_STUB=1 && cargo test
   ```

### Deploying Files to Win10
```bash
# SCP with Windows path
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa \
    local_file lilongen@192.168.3.143:"C:/ws-boxlite/remote_file"
```

---

## Timing Benchmarks (2026-04-19)

| Operation | First Run | Incremental |
|-----------|-----------|-------------|
| `pip install -e .` (Python SDK build) | ~83s | ~10-20s |
| `python -c "import boxlite"` | 0.25s | 0.25s |
| Kernel boot to guest ready | ~0.7s | ~0.7s |
| Vsock bridge test (incl. Start-Process overhead) | ~7s | ~7s |
| `cargo test -p boxlite --no-default-features --lib` | ~66s (first) | ~9s (incl 8s test exec) |
| `cargo build --example boot_kernel` | ~8s (first) | ~2s |
| `cargo build -p boxlite --bin boxlite-shim` | ~12s (first) | ~2s |

---

## Initramfs Details

The custom initramfs (`initrd.img`) is critical for WHPX. Alpine's `linux-virt` kernel has `VIRTIO_BLK=m` and no built-in vsock, so we must load modules from initramfs.

### Required Modules (must match kernel version exactly)

| Module | Purpose |
|--------|---------|
| `virtio_blk.ko` | Block device for rootfs disk |
| `vsock.ko` | AF_VSOCK protocol family |
| `vmw_vsock_virtio_transport_common.ko` | Shared virtio vsock transport |
| `vmw_vsock_virtio_transport.ko` | Guest virtio vsock transport |

### Init Script (`/init`)

```sh
#!/bin/sh
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
/bin/mount -t devtmpfs devtmpfs /dev

# Load modules
/bin/insmod /lib/modules/virtio_blk.ko
/bin/insmod /lib/modules/vsock.ko
/bin/insmod /lib/modules/vmw_vsock_virtio_transport_common.ko
/bin/insmod /lib/modules/vmw_vsock_virtio_transport.ko

# Parse root= and init= from kernel cmdline
ROOT_DEV=""
INIT_BIN="/init"
for param in $(/bin/cat /proc/cmdline); do
    case "$param" in
        root=*) ROOT_DEV="${param#root=}" ;;
        init=*) INIT_BIN="${param#init=}" ;;
    esac
done

# Mount rootfs and switch_root
/bin/mount "$ROOT_DEV" /mnt/root
exec /bin/switch_root /mnt/root "$INIT_BIN" "$@"
```

**Key learnings:**
- `init=` must be parsed from `/proc/cmdline` (was hardcoded `/init` initially)
- `"$@"` must be forwarded via `switch_root` (kernel `--` args become init argv)
- Module versions MUST match kernel exactly (6.12.80 modules fail on 6.12.81 kernel)

---

## Automated E2E Test Scripts

PowerShell test scripts are available in `scripts/test/` for reproducible E2E verification:

```powershell
# Run all 6 phases (Python import, kernel boot, vsock bridge, shim, cargo tests)
.\scripts\test\windows-e2e.ps1 -RuntimeDir C:\ws-boxlite\runtime

# Run individual tests
.\scripts\test\windows-e2e-kernel.ps1 -RuntimeDir C:\ws-boxlite\runtime
.\scripts\test\windows-e2e-vsock.ps1 -Direction outbound   # guest -> host
.\scripts\test\windows-e2e-vsock.ps1 -Direction inbound    # host -> guest
```

### Building Runtime Binaries

On a Linux machine (or Lima VM), build all Windows runtime binaries:

```bash
# Build everything: vmlinuz, initrd.img, boxlite-guest, mke2fs.exe, debugfs.exe
./scripts/build/build-windows-runtime.sh target/windows-runtime/

# Or build components individually:
./scripts/build/cross-compile-kernel-windows.sh target/kernel-windows-x86_64/
./scripts/build/build-initrd-windows.sh <kernel_src_dir> target/kernel-windows-x86_64/initrd.img
./scripts/build/cross-compile-e2fsprogs-windows.sh target/e2fsprogs-windows-x86_64/
```

The binaries can then be embedded via `include_bytes!` by setting:
```bash
export BOXLITE_KERNEL_DIR=target/windows-runtime/
```

---

## Common Failures and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'boxlite'` | SDK not installed to system Python | `pip install -e .` from `sdks/python/` |
| `python3` not found (exit code 9009) | Windows uses `python` not `python3` | Use `python` |
| `package ID specification 'boxlite-shim' did not match` | Wrong package name | `cargo build -p boxlite --bin boxlite-shim` |
| Boot kernel silent (no serial output) | Wrong kernel file or corrupt vmlinuz | Verify file size (~11.7 MB) and kernel version |
| Guest vsock EAFNOSUPPORT (errno 97) | Missing vsock kernel modules | Add vsock.ko + transport modules to initramfs |
| SimpleBox timeout (host never sees ready signal) | VMM only supported host->guest connections | Add `connect_to()` for guest->host outbound TCP |
| Build fails silently on Windows | Locked .exe from previous run | `taskkill /F /IM <name>.exe` before rebuilding |
| `maturin develop --interpreter python` fails | `--interpreter` removed in maturin 1.13+ | Use `pip install -e .` |
