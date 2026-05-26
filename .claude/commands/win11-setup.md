# Win11 Environment Setup

One-time setup for Win11 (ThinkPad T14) WHPX development/testing environment.

## Machine Info

- **SSH**: `ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221` (pw: `121314`)
- **Workspace**: `D:\ws-boxlite\`
- **Proxy**: `HTTP_PROXY=http://127.0.0.1:7897`
- **Note**: Workspace is on D: drive — use `D:` before `cd D:\path` in .bat files

## Prerequisites (manual install on Windows)

### 1. Check/Install Rust

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "rustc --version && cargo --version"
```

If missing: download `rustup-init.exe` from https://rustup.rs, install stable toolchain.
Required: rustc 1.94+ (stable), MSVC target `x86_64-pc-windows-msvc`.

### 2. Check/Install Python 3.12+

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "python --version && pip --version"
```

If missing: download from https://www.python.org/downloads/. Install to default location.
Ensure `python` and `pip` are in PATH.

### 3. Check/Install MSVC Build Tools

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "where cl.exe 2>nul && echo MSVC OK || echo MSVC MISSING"
```

If missing: install Visual Studio Build Tools (C++ workload).

### 4. Check/Install protoc

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "D:\ws-boxlite\tools\protoc\bin\protoc.exe --version 2>nul && echo PROTOC OK || echo PROTOC MISSING"
```

If missing: download protoc from https://github.com/protocolbuffers/protobuf/releases (win64.zip),
extract to `D:\ws-boxlite\tools\protoc\`.

## Automated Setup Steps

### Step 1: Create Workspace Structure

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"mkdir D:\ws-boxlite\boxlite D:\ws-boxlite\runtime D:\ws-boxlite\tools 2>nul && echo DIRS OK\""
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

### Step 4: Deploy Source to Win11

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-full-src.tar.gz t14@192.168.3.221:"D:/ws-boxlite/"
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-vendor.tar.gz t14@192.168.3.221:"D:/ws-boxlite/"
```

Extract on Win11:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"D: && cd D:\ws-boxlite && tar xzf boxlite-full-src.tar.gz -C boxlite\ && tar xzf boxlite-vendor.tar.gz -C boxlite\ && echo EXTRACT OK\""
```

### Step 5: Create .cargo/config.toml

**CRITICAL**: Without this, linking fails with LNK1169 (duplicate `rust_eh_personality`).

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"mkdir D:\ws-boxlite\boxlite\.cargo 2>nul\""
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
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/cargo-config-win.toml t14@192.168.3.221:"D:/ws-boxlite/boxlite/.cargo/config.toml"
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

**Deploy to Win11:**
```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/win-runtime/* t14@192.168.3.221:"D:/ws-boxlite/runtime/"
```

**Alternative**: Copy runtime from Win10 (if already set up):
```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/runtime/boxlite-guest" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/runtime/vmlinuz" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/runtime/initrd.img" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/runtime/mke2fs.exe" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/runtime/debugfs.exe" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-guest /tmp/vmlinuz /tmp/initrd.img /tmp/mke2fs.exe /tmp/debugfs.exe t14@192.168.3.221:"D:/ws-boxlite/runtime/"
```

**Required runtime files:**

| File | Source | Size |
|------|--------|------|
| `boxlite-guest` | Cross-compiled on macOS (musl) | ~12MB |
| `boxlite-shim.exe` | Built on Win11 (Step 7) | ~13MB |
| `vmlinuz` | libkrunfw kernel (with 9p built-in) | ~7MB |
| `initrd.img` | Built in Lima VM | ~1.5MB |
| `mke2fs.exe` | Cross-compiled e2fsprogs | ~529KB |
| `debugfs.exe` | Cross-compiled e2fsprogs | ~612KB |

### Step 7: Build boxlite-shim

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"D: && cd D:\ws-boxlite\boxlite && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set PATH=D:\ws-boxlite\tools\protoc\bin;%PATH%&& cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun 2>&1 && copy /Y target\debug\boxlite-shim.exe D:\ws-boxlite\runtime\boxlite-shim.exe && echo SHIM OK\"" 2>&1
```

First build takes ~2-5 minutes. Check output for `SHIM OK`.

### Step 8: Install Python SDK

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"D: && cd D:\ws-boxlite\boxlite\sdks\python && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_DEPS_STUB=1&& set PATH=D:\ws-boxlite\tools\protoc\bin;%PATH%&& pip install -e . 2>&1 && echo SDK OK\"" 2>&1
```

### Step 9: Cache OCI Images

**Option A**: Pull directly (needs proxy):
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_RUNTIME_DIR=D:\ws-boxlite\runtime&& python -c \"import asyncio, boxlite; asyncio.run(boxlite.Boxlite.default().pull('alpine:latest'))\" 2>&1 && echo PULL OK\"" 2>&1
```

**Option B**: Copy image cache from Win10 (faster, no proxy needed):
```bash
# On Win10: pack image cache
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd %USERPROFILE% && tar czf C:\ws-boxlite\boxlite-images.tar.gz .boxlite\images\""
# Copy via macOS relay
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143:"C:/ws-boxlite/boxlite-images.tar.gz" /tmp/
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa /tmp/boxlite-images.tar.gz t14@192.168.3.221:"D:/ws-boxlite/"
# Extract on Win11
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"cd %USERPROFILE% && tar xzf D:\ws-boxlite\boxlite-images.tar.gz && echo IMAGES OK\""
```

### Step 10: Deploy vm-bench.py

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa scripts/test/vm-bench.py t14@192.168.3.221:"D:/ws-boxlite/vm-bench.py"
```

### Step 11: Verify Setup

Run a single vm-bench test:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"D: && cd D:\ws-boxlite && set HTTP_PROXY=http://127.0.0.1:7897&& set HTTPS_PROXY=http://127.0.0.1:7897&& set BOXLITE_RUNTIME_DIR=D:\ws-boxlite\runtime&& set RUST_LOG=warn&& python vm-bench.py\"" 2>&1
```

All 8 phases should show ms times. WHPX is flaky, so retry if it fails with "transport error".

## Verification Checklist

```bash
# All checks in one command
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"echo === Toolchain === && rustc --version && python --version && echo === Workspace === && dir /b D:\ws-boxlite\boxlite\Cargo.toml && echo === Cargo Config === && type D:\ws-boxlite\boxlite\.cargo\config.toml | findstr FORCE && echo === Runtime === && dir /b D:\ws-boxlite\runtime\ && echo === SDK === && python -c \"import boxlite; print(f'boxlite {boxlite.__version__}')\" && echo === ALL OK ===\"" 2>&1
```

## Win11-Specific Notes

- **D: drive**: Workspace is on D: — always use `D:` before `cd D:\path` in .bat files
- **Python PATH**: May need explicit PATH in .bat: `set PATH=C:\Users\T14\AppData\Local\Programs\Python\Python312;C:\Users\T14\AppData\Local\Programs\Python\Python312\Scripts;%PATH%`
- **No git**: Git is not installed on Win11 — use `findstr` instead of `git diff` for verification
- **WHPX stability**: Win11 should theoretically be more stable than Win10 (PIC-HLT fix), but actual results vary by hardware

## Troubleshooting

| Problem | Symptom | Fix |
|---------|---------|-----|
| LNK1169 duplicate symbol | `rust_eh_personality` already defined | Missing `.cargo/config.toml` — redo Step 5 |
| LNK1120 unresolved externals | `krun_*` symbols not found | Built with `BOXLITE_DEPS_STUB=1` — remove it for shim build |
| protoc not found | `boxlite-shared` build error | protoc not in PATH — check Step 4 |
| Image pull fails | `error sending request for url` | Proxy not set — add HTTP_PROXY/HTTPS_PROXY |
| Python not found | `python is not recognized` | Python not in PATH — add to .bat PATH line |
| GBK encoding error | `UnicodeEncodeError: 'gbk' codec` | Add `sys.stdout.reconfigure(encoding='utf-8')` to scripts |
| `cd` doesn't switch drives | Stays on C: after `cd D:\...` | Use `D:` before `cd D:\path` in .bat |
| SSH connection reset | Win11 drops SSH during long test | WHPX crash may destabilize system — reboot and retry |
