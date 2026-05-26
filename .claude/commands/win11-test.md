# Win11 Run E2E Test

Run vm-bench.py on Win11 (T14), retrieve results, and analyze. Assumes code is already deployed and rebuilt (via `/win11-sync` + `/win11-rebuild`, or via the .bat from `/win11-sync`).

## Run Test

### 1. Determine Next Test Number

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "dir D:\\ws-boxlite\\e2e-test*.txt"
```

### 2. Execute Test (replace N)

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"cd D:\\ws-boxlite&&taskkill /F /IM boxlite-shim.exe 2>nul&set BOXLITE_RUNTIME_DIR=D:\\ws-boxlite\\runtime&&set RUST_LOG=debug&&if exist \"%USERPROFILE%\\.boxlite\\boxes\" rmdir /S /Q \"%USERPROFILE%\\.boxlite\\boxes\"&&python vm-bench.py > e2e-testN.txt 2>&1&&echo TEST DONE\"" 2>&1
```

- `taskkill` with `&` (not `&&`) — continues even if no process found
- **Timeout**: 60s. If SSH hangs, the test may still have completed on Win11.

### 3. Retrieve Results

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa "t14@192.168.3.221:D:/ws-boxlite/e2e-testN.txt" /tmp/e2e-testN.txt
```

**CRITICAL**: Forward slashes in SCP source path! Backslashes fail silently.

### 4. Analyze

Read `/tmp/e2e-testN.txt` with the Read tool. Check:

- **Success**: All 8 phases show ms times in the summary table
- **Failure patterns**:
  - `os error 2` = file not found (missing file, wrong path)
  - `os error 5` = access denied (permission issue)
  - `Broken pipe` = VM crashed or shutdown during gRPC
  - `Box initialization failed` = init pipeline error (check preceding lines)
- **Flaky**: ContainerInit "transport error" / "broken pipe" on single run — re-run once

### Quick Summary (without full read)

```bash
grep -a "Phase\|exec\|stop\|remove\|Error\|Grand" /tmp/e2e-testN.txt
```

## If SSH Hangs

Win11 T14 should be more stable than Win10 MBP, but if it hangs:

1. Stop/kill the SSH command
2. Check if output exists: `ssh ... "dir D:\\ws-boxlite\\e2e-testN.txt"`
3. If it exists with the summary table at the end, test completed — fetch it
4. If truncated, VM hung. Kill and retry:
   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "taskkill /F /IM boxlite-shim.exe 2>nul"
   ```
   Re-run with the next N.

## Read Shim Stderr (for shim-side errors)

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"dir /s /b %USERPROFILE%\\.boxlite\\boxes\\*\\stderr\""
```

Then fetch:
```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa "t14@192.168.3.221:C:/Users/t14/.boxlite/boxes/<box_id>/stderr" /tmp/shim-stderr.txt
```

## Clear Disk Cache (if needed)

Only when `image_disk.rs` or `disk/ext4.rs` changed:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa t14@192.168.3.221 "cmd /c \"if exist \"%USERPROFILE%\\.boxlite\\images\\disk-images\" rmdir /S /Q \"%USERPROFILE%\\.boxlite\\images\\disk-images\"&&echo Cleared\""
```
