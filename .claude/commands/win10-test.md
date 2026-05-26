# Win10 Run E2E Test

Run vm-bench.py on Win10, retrieve results, and analyze. Assumes code is already deployed and rebuilt (via `/win10-sync` + `/win10-rebuild`, or via the .bat from `/win10-sync`).

## Run Test

### 1. Determine Next Test Number

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "dir C:\\ws-boxlite\\e2e-test*.txt"
```

### 2. Execute Test (replace N)

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"cd C:\\ws-boxlite&&taskkill /F /IM boxlite-shim.exe 2>nul&set BOXLITE_RUNTIME_DIR=C:\\ws-boxlite\\runtime&&set RUST_LOG=debug&&if exist \"%USERPROFILE%\\.boxlite\\boxes\" rmdir /S /Q \"%USERPROFILE%\\.boxlite\\boxes\"&&python vm-bench.py > e2e-testN.txt 2>&1&&echo TEST DONE\"" 2>&1
```

- `taskkill` with `&` (not `&&`) — continues even if no process found
- **Timeout**: 60s. If SSH hangs, the test may still have completed on Win10.

### 3. Retrieve Results

```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa "lilongen@192.168.3.143:C:/ws-boxlite/e2e-testN.txt" /tmp/e2e-testN.txt
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

WHPX VM occasionally hangs during init (~20% of runs on MBP 2014). When this happens:

1. Stop/kill the SSH command
2. Check if output exists: `ssh ... "dir C:\\ws-boxlite\\e2e-testN.txt"`
3. If it exists with the summary table at the end, test completed — fetch it
4. If truncated, VM hung. Kill and retry:
   ```bash
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "taskkill /F /IM boxlite-shim.exe 2>nul"
   ```
   Re-run with the next N.

## Read Shim Stderr (for shim-side errors)

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"dir /s /b %USERPROFILE%\\.boxlite\\boxes\\*\\stderr\""
```

Then fetch:
```bash
scp -o IdentitiesOnly=yes -i ~/.ssh/id_rsa "lilongen@192.168.3.143:C:/Users/lilongen/.boxlite/boxes/<box_id>/stderr" /tmp/shim-stderr.txt
```

## Clear Disk Cache (if needed)

Only when `image_disk.rs` or `disk/ext4.rs` changed:
```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_rsa lilongen@192.168.3.143 "cmd /c \"if exist \"%USERPROFILE%\\.boxlite\\images\\disk-images\" rmdir /S /Q \"%USERPROFILE%\\.boxlite\\images\\disk-images\"&&echo Cleared\""
```
