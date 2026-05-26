# Win10 Environment Setup

One-time setup for Win10 (MBP 2014) WHPX development/testing environment.

## Machine Info

- **SSH**: `ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143` (pw: `JtwmY8.15`)
- **Workspace**: `C:\ws-boxlite\`
- **Proxy**: `HTTP_PROXY=http://127.0.0.1:7897`

## Prerequisites (manual install on Windows)

### 1. Check/Install Rust

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "rustc --version && cargo --version"
```

If missing: download `rustup-init.exe` from https://rustup.rs, install stable toolchain.
Required: rustc 1.94+ (stable), MSVC target `x86_64-pc-windows-msvc`.

### 2. Check/Install Python 3.12+

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "python --version && pip --version"
```

If missing: download from https://www.python.org/downloads/. Install to default location.
Ensure `python` and `pip` are in PATH.

### 3. Check/Install MSVC Build Tools

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "where cl.exe 2>nul && echo MSVC OK || echo MSVC MISSING"
```

If missing: install Visual Studio Build Tools (C++ workload).

### 4. Check/Install protoc

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "C:\ws-boxlite\tools\protoc\bin\protoc.exe --version 2>nul && echo PROTOC OK || echo PROTOC MISSING"
```

If missing: download protoc from https://github.com/protocolbuffers/protobuf/releases (win64.zip),
extract to `C:\ws-boxlite\tools\protoc\`.

## Automated Setup Steps

### Step 1: Create Workspace Structure

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"mkdir C:\ws-boxlite\boxlite C:\ws-boxlite\runtime C:\ws-boxlite\tools 2>nul && echo DIRS OK\""
```

### Step 2: Create Full Source Tarball (on macOS)

```bash
cd /Users/lilongen/github/boxlite
tar czf /tmp/boxlite-full-src.tar.gz \
  --exclude='target' \
  --exclude='.git' \
  --exclude='src/deps/*/vendor/*/target' \
  src/ sdks/python/ Cargo.toml Cargo.lock
```

Verify size (~50MB):
```bash
ls -lh /tmp/boxlite-full-src.tar.gz
```

### Step 3: Deploy Vendor (libkrun submodule)

The libkrun vendor directory is large and must be synced separately:

```bash
tar czf /tmp/boxlite-vendor.tar.gz \
  --exclude='target' \
  src/deps/libkrun-sys/vendor/
```

### Step 4: Deploy Source to Win10

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-full-src.tar.gz lilongen@192.168.3.143:"C:/ws-boxlite/"
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-vendor.tar.gz lilongen@192.168.3.143:"C:/ws-boxlite/"
```

Extract on Win10:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd C:\ws-boxlite && tar xzf boxlite-full-src.tar.gz -C boxlite\ && tar xzf boxlite-vendor.tar.gz -C boxlite\ && echo EXTRACT OK\""
```

### Step 5: Create .cargo/config.toml

**CRITICAL**: Without this, linking fails with LNK1169 (duplicate `rust_eh_personality`).

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"mkdir C:\ws-boxlite\boxlite\.cargo 2>nul\""
```

Create file locally and SCP:
```bash
cat > /tmp/cargo-config-win.toml << 'EOF'
[target.aarch64-unknown-linux-musl]
rustflags = ["-C", "target-feature=+crt-static", "-C", "link-arg=-Wl,-z,stack-size=2097152"]

[target.x86_64-unknown-linux-musl]
rustflags = ["-C", "target-feature=+crt-static", "-C", "link-arg=-Wl,-z,stack-size=2097152"]

# Windows MSVC: allow duplicate symbols when linking libkrun staticlib into Rust binaries.
# libkrun is built as a staticlib (bundles Rust stdlib) for C consumers, but when linked
# into a Rust binary the stdlib symbols collide. /FORCE:MULTIPLE resolves this safely
# since both copies are identical.
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "link-arg=/FORCE:MULTIPLE"]
EOF
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/cargo-config-win.toml lilongen@192.168.3.143:"C:/ws-boxlite/boxlite/.cargo/config.toml"
```

### Step 6: Deploy Runtime Files

Runtime files are built on macOS/Lima and deployed to Windows.

**Build guest binary (on macOS):**
```bash
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc \
  cargo build -p boxlite-guest --release --target x86_64-unknown-linux-musl
```

**Collect runtime files:**
```bash
mkdir -p /tmp/win-runtime
cp target/x86_64-unknown-linux-musl/release/boxlite-guest /tmp/win-runtime/
# vmlinuz and initrd.img are built separately (see build-kernel docs)
# mke2fs.exe and debugfs.exe are cross-compiled e2fsprogs
```

**Deploy to Win10:**
```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/win-runtime/* lilongen@192.168.3.143:"C:/ws-boxlite/runtime/"
```

**Required runtime files:**

| File | Source | Size |
|------|--------|------|
| `boxlite-guest` | Cross-compiled on macOS (musl) | ~12MB |
| `boxlite-shim.exe` | Built on Win10 (Step 7) | ~13MB |
| `vmlinuz` | libkrunfw kernel (with 9p built-in) | ~7MB |
| `initrd.img` | Built in Lima VM | ~1.5MB |
| `mke2fs.exe` | Cross-compiled e2fsprogs | ~529KB |
| `debugfs.exe` | Cross-compiled e2fsprogs | ~612KB |

### Step 7: Build boxlite-shim

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd C:\ws-boxlite\boxlite && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set PATH=C:\ws-boxlite\tools\protoc\bin;%PATH%&& cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun 2>&1 && copy /Y target\debug\boxlite-shim.exe C:\ws-boxlite\runtime\boxlite-shim.exe && echo SHIM OK\"" 2>&1
```

First build takes ~2-5 minutes. Check output for `SHIM OK`.

### Step 8: Install Python SDK

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd C:\ws-boxlite\boxlite\sdks\python && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_DEPS_STUB=1&& set PATH=C:\ws-boxlite\tools\protoc\bin;%PATH%&& pip install -e . 2>&1 && echo SDK OK\"" 2>&1
```

### Step 9: Cache OCI Images

Pull alpine and debian images (needed by vm-bench.py):

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_RUNTIME_DIR=C:\ws-boxlite\runtime&& python -c \"import asyncio, boxlite; asyncio.run(boxlite.Boxlite.default().pull('alpine:latest'))\" 2>&1 && echo PULL OK\"" 2>&1
```

**Alternative**: Copy image cache from another machine:
```bash
# On source machine: tar czf /tmp/boxlite-images.tar.gz -C $HOME/.boxlite images/
# SCP to Win10 and extract to %USERPROFILE%\.boxlite\
```

### Step 10: Deploy vm-bench.py

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa scripts/test/vm-bench.py lilongen@192.168.3.143:"C:/ws-boxlite/vm-bench.py"
```

### Step 11: Verify Setup

Run a single vm-bench test:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd C:\ws-boxlite && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_RUNTIME_DIR=C:\ws-boxlite\runtime&& set RUST_LOG=warn&& python vm-bench.py\"" 2>&1
```

All 8 phases should show ms times. WHPX is flaky (~15-20% success on this machine), so retry if it fails with "transport error".

## Verification Checklist

```bash
# All checks in one command
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"echo === Toolchain === && rustc --version && python --version && echo === Workspace === && dir /b C:\ws-boxlite\boxlite\Cargo.toml && echo === Cargo Config === && type C:\ws-boxlite\boxlite\.cargo\config.toml | findstr FORCE && echo === Runtime === && dir /b C:\ws-boxlite\runtime\ && echo === SDK === && python -c \"import boxlite; print(f'boxlite {boxlite.__version__}')\" && echo === ALL OK ===\"" 2>&1
```

## Troubleshooting

| Problem | Symptom | Fix |
|---------|---------|-----|
| LNK1169 duplicate symbol | `rust_eh_personality` already defined | Missing `.cargo/config.toml` — redo Step 5 |
| LNK1120 unresolved externals | `krun_*` symbols not found | Built with `BOXLITE_DEPS_STUB=1` — remove it for shim build |
| protoc not found | `boxlite-shared` build error | protoc not in PATH — check Step 4 |
| Image pull fails | `error sending request for url` | Proxy not set — add HTTP_PROXY/HTTPS_PROXY |
| Python not found | `python is not recognized` | Python not in PATH — reinstall with "Add to PATH" |
| GBK encoding error | `UnicodeEncodeError: 'gbk' codec` | Add `sys.stdout.reconfigure(encoding='utf-8')` to scripts |
| `cd` doesn't switch drives | Stays on C: after `cd D:\...` | Use drive letter first: `D:` then `cd D:\path` |
