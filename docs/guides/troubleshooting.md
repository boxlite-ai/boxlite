# Troubleshooting

## "Image pull failed" error

**Causes:**
1. Network connectivity issues
2. Invalid image name/tag
3. Private image requires authentication
4. Registry not reachable

**Solutions:**

```bash
# Test with Docker first
docker pull <image>

# Check network
ping registry-1.docker.io

# For private images, authenticate
docker login

# Check image name format
# Correct: "python:3.11-slim"
# Wrong: "python/3.11-slim"

# Clear the image cache if corrupted. Box disks are backed by files
# in it, so remove existing boxes first (boxlite rm).
rm -rf ~/.boxlite/images/*
```

**Debug:**
```bash
RUST_LOG=debug python script.py
# Look for image-related errors in output
```

## "Box fails to start" error

**Debug checklist:**

1. **Check disk space:**
   ```bash
   df -h ~/.boxlite
   # Should have at least 1 GB free
   ```

2. **Verify hypervisor:**
   ```bash
   # Linux
   ls -l /dev/kvm
   lsmod | grep kvm

   # macOS
   sw_vers | grep ProductVersion  # Should be 12+
   uname -m  # Should be arm64
   ```

3. **Check image:**
   ```bash
   docker pull <image>
   # Should succeed
   ```

4. **Enable debug logging:**
   ```bash
   RUST_LOG=debug python script.py
   ```

5. **Check permissions:**
   ```bash
   # Linux: Ensure user in kvm group
   groups | grep kvm

   # If not, add and relogin
   sudo usermod -aG kvm $USER
   ```

## Ubuntu 24.04: "Timeout waiting for guest ready" / box only starts with sudo

**Symptom:** Box creation fails with "Timeout waiting for guest ready (30s)"
or "VM subprocess exited before guest became ready" on Ubuntu 24.04.
Works with `sudo` or on Ubuntu 25.04+.

**Root Cause:** Ubuntu 24.04 restricts unprivileged user namespaces via
AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`) but does not
ship the `bwrap-userns-restrict` profile that Ubuntu 25.04+ includes.
bwrap (bubblewrap) needs user namespaces for sandbox isolation.

**Diagnosis:**

```bash
# Check for AppArmor denials
dmesg | grep apparmor
# Look for: apparmor="DENIED" ... comm="bwrap" capability=8

# Check if bwrap profile exists
aa-status | grep bwrap
# Should show "bwrap-userns-restrict" if profile is installed
```

**Fix (Option A — targeted, recommended):**

Install the bwrap AppArmor profile that Ubuntu 25.04+ ships. Create the file
`/etc/apparmor.d/bwrap-userns-restrict` with the following content, then reload:

```bash
sudo tee /etc/apparmor.d/bwrap-userns-restrict << 'PROFILE'
abi <abi/4.0>,

include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(attach_disconnected,mediate_deleted) {
  allow capability,
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,
  allow pix /** -> &bwrap//&unpriv_bwrap,
  include if exists <local/bwrap-userns-restrict>
}

profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {
  allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,
  allow pix /** -> &unpriv_bwrap,
  audit deny capability,
  include if exists <local/unpriv_bwrap>
}
PROFILE

sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

**Fix (Option B — quick, less secure):**

Disable the restriction globally:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

# To persist across reboots:
echo "kernel.apparmor_restrict_unprivileged_userns=0" | \
  sudo tee /etc/sysctl.d/99-boxlite-userns.conf
```

**Fix (Option C — disable jailer):**

If you don't need sandbox isolation (e.g., development environment),
disable the jailer:

```python
from boxlite.boxlite import SecurityOptions, AdvancedBoxOptions

boxlite.BoxOptions(
    advanced=AdvancedBoxOptions(security=SecurityOptions.development()),
    # ... other options
)
```

## "Command hangs" or "execution timeout"

**Causes:**
1. Command is waiting for input
2. Long-running operation
3. Deadlock or infinite loop

**Solutions:**

```python
import asyncio

# Add timeout
async def execute_with_timeout():
    execution = await box.exec("command")

    try:
        result = await asyncio.wait_for(
            execution.wait(),
            timeout=30  # 30 second timeout
        )
        return result
    except asyncio.TimeoutError:
        await execution.kill()
        print("Command timed out")
```

**Check if command needs input:**
```python
# Provide stdin if needed
execution = await box.exec("command")
stdin = execution.stdin()
await stdin.write("input\n")
await stdin.close()
```

## "Port forward not working"

**Debug steps:**

1. **Check port is not in use:**
   ```bash
   lsof -i :8080
   # Should be empty, or show boxlite process
   ```

2. **Verify configuration:**
   ```python
   # Correct
   ports=[(8080, 80, "tcp")]

   # Wrong (swapped)
   # ports=[(80, 8080, "tcp")]  # Don't do this
   ```

3. **Test from inside box:**
   ```python
   # Start server in a Box from runtime.create; exec returns while it runs
   server = await box.exec("python", ["-u", "-m", "http.server", "80"])
   async for line in server.stdout():  # wait until it is listening
       if "Serving HTTP" in line:
           break

   # Test from host
   import requests
   response = requests.get("http://localhost:8080")
   ```

4. **Check the shim:** gvproxy runs inside each box's `boxlite-shim` process.
   ```bash
   ps aux | grep boxlite-shim
   # Should show one process per running box
   ```

## "Permission denied" errors

**Common scenarios:**

**1. ~/.boxlite directory:**
```bash
chmod 755 ~/.boxlite
chown -R $USER ~/.boxlite
```

**2. /dev/kvm (Linux):**
```bash
# Check permissions
ls -l /dev/kvm
# Should be: crw-rw---- 1 root kvm

# Add user to kvm group
sudo usermod -aG kvm $USER
# Logout and login required
```

**3. Volume mounts:**
```bash
# Ensure host path is accessible
chmod 755 /host/path
```

## "Out of memory" / "box killed"

**Cause:** Box exceeded memory limit.

**Solutions:**

1. **Increase memory limit:**
   ```python
   boxlite.BoxOptions(
       memory_mib=2048,  # Increase from 512 to 2048
   )
   ```

2. **Check actual usage:**
   ```python
   metrics = await box.metrics()
   print(f"Memory: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
   ```

3. **Optimize code:**
   - Reduce memory footprint of executed code
   - Process data in chunks instead of loading all at once
   - Clear variables when no longer needed

4. **Use swap (Linux only, not recommended):**
   - Better to increase `memory_mib`

## "KVM not available" (Linux)

**Cause:** KVM module not loaded or not accessible.

**Solutions:**

1. **Load KVM module:**
   ```bash
   sudo modprobe kvm kvm_intel  # For Intel CPUs
   sudo modprobe kvm kvm_amd    # For AMD CPUs

   # Verify
   lsmod | grep kvm
   ```

2. **Check CPU support:**
   ```bash
   grep -E 'vmx|svm' /proc/cpuinfo
   # Should show vmx (Intel) or svm (AMD)
   ```

3. **Enable in BIOS:**
   - Reboot and enter BIOS/UEFI
   - Enable "Intel VT-x" or "AMD-V"
   - Save and reboot

4. **Add user to kvm group:**
   ```bash
   sudo usermod -aG kvm $USER
   # Logout and login
   ```

## "Hypervisor.framework not available" (macOS)

**Cause:** Running on unsupported macOS version or architecture.

**Solutions:**

1. **Check macOS version:**
   ```bash
   sw_vers
   # ProductVersion should be 12.0 or higher
   ```

2. **Check architecture:**
   ```bash
   uname -m
   # Should output: arm64 (Apple Silicon)
   ```

3. **Upgrade if needed:**
   - BoxLite requires macOS 12+ (Monterey or later)
   - Apple Silicon (M1, M2, M3, M4) only
   - Intel Macs are **not supported**

**Note:** If you have an Intel Mac, consider:
- Using a Linux VM
- Deploying to cloud (AWS, GCP, Azure)
- Using a cloud-based sandboxing service
