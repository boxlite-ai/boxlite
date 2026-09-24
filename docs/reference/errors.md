# Error codes and handling

## Error types

BoxLite uses a centralized error enum with specific variants for different error categories.

### `UnsupportedEngine`

Platform or hypervisor not supported.

**Cause:**
- Running on Windows
- Running on Intel Mac
- KVM not available on Linux
- Hypervisor.framework not available on macOS

**Example:**
```text
Error: unsupported engine kind
```

**Solution:**
- Use supported platform (macOS ARM64, Linux x86_64/ARM64)
- Verify hypervisor availability:
  - Linux: `grep -E 'vmx|svm' /proc/cpuinfo`
  - macOS: Ensure macOS 12+ on Apple Silicon

### `Engine(String)`

Hypervisor or VM engine error.

**Cause:**
- KVM module not loaded
- Insufficient permissions for `/dev/kvm`
- Hypervisor.framework error
- VM creation failed

**Example:**
```text
Error: engine reported an error: KVM is not available
```

**Solution:**
```bash
# Linux: Load KVM module
sudo modprobe kvm kvm_intel  # or kvm_amd

# Linux: Check /dev/kvm permissions
ls -l /dev/kvm

# Linux: Add user to kvm group
sudo usermod -aG kvm $USER
# (logout and login required)
```

### `Config(String)`

Invalid box configuration.

**Cause:**
- Invalid CPU count (< 1 or > host CPUs)
- Invalid memory size (< 128 or > 65536)
- Invalid paths in volumes
- Invalid port numbers

**Example:**
```text
Error: configuration error: CPU count must be between 1 and 8
```

**Solution:**
- Verify configuration parameters are within valid ranges
- Check file paths exist for volume mounts
- Ensure port numbers are valid (1-65535)

### `Storage(String)`

Filesystem or disk operation error.

**Cause:**
- Disk full (`~/.boxlite` partition)
- Permission denied writing to `~/.boxlite`
- Disk image creation failed
- QCOW2 operation failed

**Example:**
```text
Error: storage error: No space left on device
```

**Solution:**
```bash
# Check disk space
df -h ~/.boxlite

# Check permissions
ls -ld ~/.boxlite
chmod 755 ~/.boxlite

# Clean up old boxes
boxlite rm <box>
```

### `Image(String)`

OCI image pull or extraction error.

**Cause:**
- Network connectivity issues
- Invalid image name or tag
- Registry authentication required
- Image not found in registry
- Corrupted image layers

**Example:**
```text
Error: images error: failed to pull image: 404 Not Found
```

**Solution:**
```bash
# Verify image exists
docker pull <image>

# Check network connectivity
ping registry-1.docker.io

# Authenticate for private images
docker login

# Clear the image cache if corrupted. Box disks are backed by files
# in it, so remove existing boxes first (boxlite rm).
rm -rf ~/.boxlite/images/*
```

### `Portal(String)`

Host-guest communication error (gRPC over vsock).

**Cause:**
- Guest agent not responding
- vsock connection failed
- gRPC timeout
- Guest initialization failed

**Example:**
```text
Error: portal error: connection timeout
```

**Solution:**
- Enable debug logging: `RUST_LOG=debug`
- Check if box is running: `box.info().await?.status`
- Restart box: `box.stop()` and recreate
- Report issue with logs if persists

### `Network(String)`

Network configuration or connectivity error.

**Cause:**
- gvproxy not running or crashed
- Port already in use
- Network backend initialization failed

**Example:**
```text
Error: network error: bind: address already in use
```

**Solution:**
```bash
# Check port availability
lsof -i :8080

# Stop conflicting process or use different port
ports=[(8081, 80, "tcp")]

# gvproxy runs inside each box's shim process; verify the shim is running
ps aux | grep boxlite-shim
```

### `Execution(String)`

Command execution error.

**Cause:**
- Command not found in image
- Command crashed or killed
- Execution timeout
- Streaming I/O error

**Example:**
```text
Error: Execution error: command not found: python3
```

**Solution:**
- Verify command exists in image:
  ```python
  result = await box.exec("which", "python3")
  ```
- Check exit code and stderr:
  ```python
  result = await box.exec("command")
  if result.exit_code != 0:
      print(f"Failed: {result.stderr}")
  ```

### `Internal(String)`

Internal BoxLite error.

**Cause:**
- Unexpected internal state
- I/O error
- JSON parsing error
- Unhandled edge case

**Example:**
```text
Error: internal error: unexpected state transition
```

**Solution:**
- Enable debug logging: `RUST_LOG=debug python script.py`
- Report issue with full logs to GitHub
- Include BoxLite version, platform, and reproduction steps

### `NotFound(String)`

Box or resource not found.

**Cause:**
- Box ID doesn't exist
- Box was removed
- Image not in cache

**Example:**
```text
Error: box not found: 01JJNH8...
```

**Solution:**
- List all boxes: `await runtime.list_info()`
- Verify box ID is correct
- Create new box if needed

### `AlreadyExists(String)`

Box or resource already exists.

**Cause:**
- Duplicate box creation attempt
- Port already forwarded

**Example:**
```text
Error: already exists: box with this ID exists
```

**Solution:**
- Use existing box: `await runtime.get(box_id)`
- Remove existing box: `await runtime.remove(box_id)`
- Use different configuration (e.g., different port)

### `InvalidState(String)`

Box is in wrong state for requested operation.

**Cause:**
- Executing command on stopped box
- Stopping already stopped box
- Restarting box that never started

**Example:**
```text
Error: invalid state: cannot execute on stopped box
```

**Solution:**
- Check box status: `info = await box.info(); print(info.state.status)`
- Restart box if stopped: `await runtime.get(box_id)` (may auto-restart)
- Create new box if needed

## Error handling patterns

### Python

```python
import boxlite

async def safe_execution():
    try:
        async with boxlite.SimpleBox(image="python:slim") as box:
            result = await box.exec("python", "script.py")

            # Check exit code
            if result.exit_code != 0:
                print(f"Command failed: {result.stderr}")
                return

    except Exception as e:
        # All BoxLite errors are raised as Python exceptions
        print(f"Error: {e}")

        # Enable debug logging for details
        # RUST_LOG=debug python script.py
```

### Rust

```rust
use boxlite::{BoxOptions, BoxliteError, BoxliteResult, BoxliteRuntime, RootfsSpec};

#[tokio::main]
async fn main() -> BoxliteResult<()> {
    let runtime = BoxliteRuntime::default_runtime();
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        ..Default::default()
    };

    match runtime.create(options, None).await {
        Ok(_litebox) => {
            // Success
        }
        Err(BoxliteError::UnsupportedEngine) => {
            eprintln!("Platform not supported");
            return Err(BoxliteError::UnsupportedEngine);
        }
        Err(BoxliteError::Image(msg)) => {
            eprintln!("Image error: {}", msg);
            // Handle image-specific error
        }
        Err(e) => {
            eprintln!("Unexpected error: {}", e);
            return Err(e);
        }
    }

    Ok(())
}
```
