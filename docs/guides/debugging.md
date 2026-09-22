# Debugging

Enable debug logging and inspect box state for troubleshooting.

## Enable debug logging

**Python:**

```bash
# Debug logging
RUST_LOG=debug python script.py

# Trace logging (very verbose)
RUST_LOG=trace python script.py

# Module-specific logging
RUST_LOG=boxlite::runtime=debug python script.py
```

**Rust:**

```bash
RUST_LOG=debug cargo run
```

**Log Levels:**
- `trace` - Very verbose, all details
- `debug` - Debug information
- `info` - Informational messages
- `warn` - Warnings
- `error` - Errors only

## Inspect box state

**Get Box Information:**

```python
box = await runtime.create(boxlite.BoxOptions(image="alpine"))
info = await box.info()

print(f"ID: {info.id}")
print(f"Status: {info.state.status}")
print(f"Image: {info.image}")
print(f"CPUs: {info.cpus}")
print(f"Memory: {info.memory_mib} MiB")
print(f"Created: {info.created_at}")
```

**Get Box Metrics:**

```python
metrics = await box.metrics()

print(f"CPU time: {metrics.cpu_time_ms}ms")
print(f"Memory usage: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
print(f"Network sent: {metrics.network_bytes_sent}")
print(f"Network received: {metrics.network_bytes_received}")
```

**List All Boxes:**

```python
boxes = await runtime.list_info()
for info in boxes:
    print(f"{info.id}: {info.state.status} ({info.image})")
```

## Common issues & debug steps

### Issue: Box fails to start

**Debug Steps:**

1. Check disk space:
   ```bash
   df -h ~/.boxlite
   ```

2. Enable debug logging:
   ```bash
   RUST_LOG=debug python script.py
   ```

3. Verify image exists:
   ```bash
   docker pull <image>
   ```

4. Check hypervisor:
   ```bash
   # Linux
   ls -l /dev/kvm
   grep -E 'vmx|svm' /proc/cpuinfo

   # macOS
   sw_vers  # Should be 12+
   uname -m  # Should be arm64
   ```

### Issue: Command execution fails

**Debug Steps:**

1. Check exit code:
   ```python
   result = await box.exec("command")
   if result.exit_code != 0:
       print(f"Exit code: {result.exit_code}")
       print(f"Stderr: {result.stderr}")
   ```

2. Verify command exists:
   ```python
   result = await box.exec("which", "python3")
   print(result.stdout)  # Should print path
   ```

3. Check working directory:
   ```python
   result = await box.exec("pwd")
   print(result.stdout)
   ```

### Issue: Performance problems

**Debug Steps:**

1. Check resource usage:
   ```python
   metrics = await box.metrics()
   print(f"Memory: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
   print(f"CPU time: {metrics.cpu_time_ms}ms")
   ```

2. Increase limits:
   ```python
   boxlite.BoxOptions(
       cpus=4,
       memory_mib=4096,
   )
   ```

3. Monitor runtime metrics:
   ```python
   runtime_metrics = await runtime.metrics()
   print(f"Active boxes: {runtime_metrics.active_boxes}")
   print(f"Total exec calls: {runtime_metrics.total_exec_calls}")
   ```

## Log locations

**Runtime Logs:**
- Location: `~/.boxlite/logs/`
- Enable with: `RUST_LOG=debug`

**Guest Logs:**
- Inside box: `/var/log/`
- Requires keeping the box after stop (`auto_delete=0`)

**Database:**
- `~/.boxlite/db/boxlite.db`

**Inspect Database:**

```bash
sqlite3 ~/.boxlite/db/boxlite.db
.tables
SELECT * FROM box_state;
```
