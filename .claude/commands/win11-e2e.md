# Win11 Full E2E Workflow

Complete Win11 (T14) E2E testing workflow. Execute these commands in order.

## Workflow

### 1. Local Validation (before deploying)

```bash
cargo test -p boxlite --no-default-features --lib
cargo clippy -p boxlite --no-default-features --lib -- -D warnings
```

Fix any failures before proceeding.

### 2. `/win11-sync` — Pack + Deploy + Generate .bat

Creates tarball of modified `src/` files, generates a rebuild+test .bat script, and SCPs both to Win11.

### 3. Execute .bat on Win11

Two options:

**Option A: Run the .bat (rebuild + test in one shot)**
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cd D:\\ws-boxlite && win11-e2eN.bat > e2e-testN.txt 2>&1 && echo DONE"
```
Timeout: 300s (covers build + test).

**Option B: Step by step (more control)**
- `/win11-rebuild` — Rebuild shim and/or SDK
- `/win11-test` — Run test + retrieve + analyze

### 4. `/win11-test` — Retrieve + Analyze Results

Fetches `e2e-testN.txt` from Win11, reads it, and checks for success.

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| `set VAR=val &&` (space!) | pip "Failed to parse" proxy URL | `set VAR=val&&` — NO space before `&&` |
| Missing file in tarball | Same error as before fix | Verify with `findstr` in .bat |
| Didn't rebuild SDK | SDK uses old crate code | Rebuild BOTH shim + SDK |
| Disk cache stale | Permission/format bugs persist | Clear `disk-images/` (see `/win11-sync`) |
| SCP backslash paths | "No such file" on retrieve | Use `D:/path/` not `D:\\path\\` |
| Locked .exe | Build silently produces old binary | `taskkill` before build |
| Stale shim | "transport error" / broken pipe | `taskkill /F /IM boxlite-shim.exe` |
| Flaky ContainerInit | Passes on retry | Re-run once; if consistent, it's a real bug |

## Success Criteria

All 8 phases of vm-bench.py show ms times:
```
1. import boxlite           ~80 ms
2. runtime_init             ~100 ms
3. box_create                ~6 ms  (cached) / ~250 ms (first)
4. first_exec (cold)      ~1700 ms
5. second_exec (warm)       ~55 ms
6. third_exec (warm)        ~36 ms
7. stop                    ~155 ms
8. remove                   ~55 ms
```
