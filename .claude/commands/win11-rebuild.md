# Win11 Rebuild (shim + SDK)

Rebuild boxlite-shim and/or Python SDK on Win11 (T14) after code has been deployed.

**CRITICAL Windows `set` rule**: `set VAR=value&&` — NO space before `&&`. A trailing space becomes part of the value and breaks URL parsing in pip/cargo.

## Quick Rebuild (Both)

**Shim:**
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"cd D:\\ws-boxlite\\boxlite&&set HTTP_PROXY=http://127.0.0.1:7897&&set HTTPS_PROXY=http://127.0.0.1:7897&&set PATH=D:\\ws-boxlite\\tools\\protoc\\bin;%PATH%&&taskkill /F /IM boxlite-shim.exe 2>nul&cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun&&copy /Y target\\debug\\boxlite-shim.exe D:\\ws-boxlite\\runtime\\boxlite-shim.exe&&echo SHIM OK\"" 2>&1
```

**SDK** (separate command, different working dir):
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"cd D:\\ws-boxlite\\boxlite\\sdks\\python&&set HTTP_PROXY=http://127.0.0.1:7897&&set HTTPS_PROXY=http://127.0.0.1:7897&&set BOXLITE_DEPS_STUB=1&&pip install -e .&&echo SDK OK\"" 2>&1
```

## Preferred: Use .bat Script

For reliability, write a `.bat` file instead of SSH one-liners (avoids quoting/set issues):

```bat
@echo off
cd D:\ws-boxlite\boxlite
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set PATH=D:\ws-boxlite\tools\protoc\bin;%PATH%
taskkill /F /IM boxlite-shim.exe 2>nul
cargo build -p boxlite --bin boxlite-shim --no-default-features --features krun
if %ERRORLEVEL% NEQ 0 (echo SHIM FAILED & exit /b 1)
copy /Y target\debug\boxlite-shim.exe D:\ws-boxlite\runtime\boxlite-shim.exe
echo === Shim OK ===
set BOXLITE_DEPS_STUB=1
cd D:\ws-boxlite\boxlite\sdks\python
pip install -e .
if %ERRORLEVEL% NEQ 0 (echo SDK FAILED & exit /b 1)
echo === SDK OK ===
```

## When to Rebuild What

| Component | When to rebuild |
|-----------|----------------|
| **Shim only** | Changes in `src/boxlite/src/bin/shim/` only |
| **SDK only** | Changes in `src/boxlite/src/images/`, `src/boxlite/src/litebox/`, `src/boxlite/src/disk/` |
| **Both** | Changes in `src/boxlite/src/vmm/`, `src/boxlite/src/portal/`, `Cargo.toml`, or unsure |

## Build Times (incremental)

- Shim: ~10-50s (depends on what changed)
- SDK: ~20-80s (first build ~83s, incremental ~10-20s)

## Prerequisite

Always kill old shim before rebuild:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "taskkill /F /IM boxlite-shim.exe 2>nul"
```
