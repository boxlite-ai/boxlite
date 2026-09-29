# FAQ

Frequently asked questions about BoxLite. Fixes for specific errors are in
[Troubleshooting](guides/troubleshooting.md).

## General questions

### What is BoxLite?

BoxLite is an embeddable virtual machine runtime for secure, isolated code execution. Think of it as "SQLite for sandboxing" - a lightweight library you can embed directly in your application without requiring a daemon or root privileges.

### What's the difference between BoxLite and Docker?

| Feature | BoxLite | Docker |
|---------|---------|--------|
| **Isolation** | Hardware VM (KVM/Hypervisor.framework) | Container (namespaces/cgroups) |
| **Daemon** | No daemon required | Requires Docker daemon |
| **Root** | No root required | Typically needs root/sudo |
| **Architecture** | Embeddable library | Client-server architecture |
| **Use Case** | Embedded sandboxing, AI agents | Application deployment, CI/CD |
| **Startup** | ~1-2 seconds | ~100-500ms |
| **Isolation Level** | Separate kernel, hardware isolation | Shared kernel |

**When to use BoxLite:**
- AI agents that need full execution freedom
- Untrusted code execution
- Hardware-level isolation required
- Embedded in applications (no daemon)

**When to use Docker:**
- Application deployment
- Development environments
- CI/CD pipelines
- Established Docker workflows

### Do I need root or sudo?

**No.** BoxLite doesn't require root privileges.

**macOS:** Hypervisor.framework is available to all users (no special permissions)

**Linux:** Only requires access to `/dev/kvm`, which can be granted through group membership:

```bash
sudo usermod -aG kvm $USER
# Logout and login for changes to take effect
```

### Can I use BoxLite on Windows?

**Yes**, through WSL2 (Windows Subsystem for Linux).

**Requirements:**
- Windows 10 version 2004+ or Windows 11
- WSL2 with a Linux distribution (Ubuntu recommended)
- KVM support enabled in WSL2

**Setup:**
```bash
# Inside WSL2, add your user to the kvm group
sudo usermod -aG kvm $USER

# Apply the new group membership (pick one):
newgrp kvm
# OR restart WSL from Windows PowerShell:
# wsl.exe --shutdown

# Verify KVM access
python3 -c "open('/dev/kvm','rb').close(); print('kvm ok')"
```

**Common Issue:** If you see "Timeout waiting for guest ready (30s)" errors, your shell cannot open `/dev/kvm`. This happens when:
- `/dev/kvm` is owned by `root:kvm` with mode `660`
- Your user is not in the `kvm` group

Run `sudo usermod -aG kvm $USER` and restart WSL with `wsl.exe --shutdown`.

**Note:** Native Windows (without WSL2) is not supported. BoxLite requires KVM (Linux) or Hypervisor.framework (macOS).

### What Python versions are supported?

**Python 3.10 or later.**

Check your version:
```bash
python --version  # Should be 3.10+
```

Upgrade if needed:
```bash
# macOS (Homebrew)
brew install python@3.11

# Ubuntu/Debian
sudo apt install python3.11

# Or use pyenv
pyenv install 3.11.0
```

### Is BoxLite production-ready?

**Yes.** BoxLite is stable and used in production.

**Production considerations:**
- ✅ Stable API
- ✅ Hardware-level isolation
- ✅ Resource limits enforced
- ✅ Error handling robust
- ⚠️ Monitor resource usage
- ⚠️ Test at expected scale
- ⚠️ Configure appropriate limits

See [Deployment Patterns](./guides/deployment-patterns.md) for production checklist.

### What's the license?

Apache License 2.0. Free for commercial and non-commercial use.

See [LICENSE](../LICENSE) for details.

## Technical questions

### What hypervisor does BoxLite use?

**macOS:** Hypervisor.framework (built into macOS 12+)

**Linux:** KVM (Kernel-based Virtual Machine)

**How it works:**
- BoxLite uses libkrun as the hypervisor abstraction
- libkrun provides a unified API over Hypervisor.framework (macOS) and KVM (Linux)
- Each box runs as a separate microVM with its own kernel

### How much memory does each box use?

**Minimum:** 128 MiB (configured via `memory_mib`)

**Default:** 512 MiB

**Range:** 128 MiB to 64 GiB (65536 MiB)

**Overhead:**
- VM overhead: ~50-100 MB per box
- Guest kernel: ~20-40 MB
- Container: Depends on image

**Example:**
```python
# Lightweight box
boxlite.BoxOptions(memory_mib=128)  # Minimum for Alpine

# Standard box
boxlite.BoxOptions(memory_mib=512)  # Default, good for Python

# Heavy box
boxlite.BoxOptions(memory_mib=2048)  # For complex workloads
```

### What's the box startup time?

**Typical:** 1-2 seconds

**Factors:**
- Image size (cached vs first pull)
- Disk I/O speed
- Available resources

**First run:** 5-30 seconds (includes image pull)

**Subsequent runs:** 1-2 seconds (image cached)

**Optimization:**
- Pre-pull images: `await runtime.images.pull("...")`
- Reuse boxes instead of creating new ones
- Use smaller base images (`alpine:latest` vs `ubuntu:latest`)

### Can I persist data between boxes?

**Yes.** Keep a box after stop to keep its disk, or mount a volume to share data between boxes.

**Default:**
```python
boxlite.BoxOptions()  # The box and its disk are removed when it stops
```

**Kept after stop:**
```python
boxlite.BoxOptions(
    disk_size_gb=10,  # 10 GB QCOW2 disk
    auto_delete=0,    # keep the box after stop
)

# Data survives stop/restart
await box.stop()
# ... later ...
box = await runtime.get(box_id)  # Disk intact
```

**Also:**
- Use volume mounts for host-box data sharing
- Read-write volumes persist changes to host filesystem

### How do I debug BoxLite issues?

**1. Enable debug logging:**

```bash
RUST_LOG=debug python script.py
```

**2. Check box status:**

```python
info = await box.info()
print(f"Status: {info.state.status}")

metrics = await box.metrics()
print(f"Memory: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
```

**3. Inspect filesystem:**

```bash
# Check disk space
df -h ~/.boxlite

# Check box data
ls -la ~/.boxlite/boxes/

# Check image cache
ls -la ~/.boxlite/images/
```

**4. Check hypervisor:**

```bash
# Linux
ls -l /dev/kvm
lsmod | grep kvm

# macOS
sw_vers  # Should be 12+
uname -m  # Should be arm64
```

See [Debugging Guide](./guides/debugging.md) for comprehensive troubleshooting.

## Networking

### Does BoxLite support internet access?

**Yes.** All boxes have full internet access by default.

**Outbound connections:**
- HTTP/HTTPS requests
- DNS resolution
- Any protocol (TCP/UDP)

**Example:**
```python
async with boxlite.SimpleBox(image="alpine:latest") as box:
    # Test internet access
    result = await box.exec("wget", "-O-", "https://api.github.com/zen")
    print(result.stdout)
```

### How do I expose ports from a box?

Use the `ports` parameter for port forwarding:

```python
boxlite.BoxOptions(
    ports=[
        (8080, 80, "tcp"),      # Host 8080 → Guest 80
        (5432, 5432, "tcp"),    # PostgreSQL
        {"guest_port": 3000},   # OS-selected host port
    ]
)
```

**Access from host:**
```bash
curl http://localhost:8080
```

Port publication is local-only and TCP-only. It creates a listener that ordinary
host applications can use for repeated connections. Remote runtimes reject
`ports`; use `box.network.tunnel(port)` for portable SDK access. Each tunnel is
a prepared one-shot connection; call `forward()` to turn it into a listener.
Image `EXPOSE` declarations do not publish host ports.

See [Configuring Networking](./guides/networking.md) for details.

### Can boxes communicate with each other?

**Not directly.** Boxes are isolated from each other.

**Alternatives:**
1. **Share data via volumes:**
   ```python
   volumes=[("/host/shared", "/mnt/shared", False)]
   ```

2. **Use host network:**
   - Box A exposes port
   - Box B connects to `host.boxlite.internal:port`
   - With an empty `allow_net`, host loopback services are reachable from
     inside the box; a non-empty `allow_net` must list `"192.168.127.254"`
     or a CIDR covering it

3. **External service:**
   - Both boxes connect to Redis/database on host or network

## Performance

### Why is my box slow?

**Common causes:**

1. **Insufficient resources:**
   ```python
   # Increase limits
   boxlite.BoxOptions(
       cpus=4,          # More CPUs
       memory_mib=4096, # More memory
   )
   ```

2. **Disk I/O:**
   - Check host disk speed: `dd if=/dev/zero of=test bs=1M count=1024`

3. **Too many boxes:**
   ```python
   metrics = await runtime.metrics()
   print(f"Active boxes: {metrics.active_boxes}")
   # Reduce concurrency or increase host resources
   ```

4. **Image size:**
   - Use smaller images: `alpine:latest` (5 MB) vs `ubuntu:latest` (77 MB)
   - Check image size: `docker images`

### Can I run 100 boxes concurrently?

**It depends on host resources.**

**Resource calculation:**
```text
Total Memory = (boxes * memory_mib) + overhead
Total CPUs = boxes * cpus (can oversubscribe)

Example:
100 boxes * 512 MiB = 51.2 GB memory needed
100 boxes * 1 CPU = 100 CPUs (oversubscribed, shares-based)
```

**Best practices:**
- Start small (10 boxes) and scale up
- Monitor metrics: `(await runtime.metrics()).active_boxes`
- Use resource pooling (reuse boxes)
- Test at expected load

**Example:**
```python
import asyncio

async def run_100_boxes():
    tasks = []
    for i in range(100):
        task = run_box(i)
        tasks.append(task)

    results = await asyncio.gather(*tasks)
```

### What's the maximum box size?

**No hard limit**, but practical constraints:

**Memory:**
- Range: 128 MiB to 64 GiB (65536 MiB)
- Limited by host RAM

**Disk:**
- Range: 1 GB to 1 TB
- Limited by host storage

**CPUs:**
- Range: 1 to host CPU count
- Can oversubscribe (shares-based)

**Tested configurations:**
- ✅ 64 GiB memory
- ✅ 1 TB disk
- ✅ 16 CPUs

## Getting help

### Where can I get help?

**Documentation:**
- [Getting Started](./getting-started/README.md) - Quick onboarding
- [Python SDK README](../sdks/python/README.md) - Complete Python API
- [Guides](./guides/README.md) - Practical guides
- [Reference](./reference/README.md) - API and configuration reference
- [Concepts](./concepts/README.md) - How BoxLite works

**Community:**
- [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues) - Bug reports and feature requests
- [GitHub Discussions](https://github.com/boxlite-ai/boxlite/discussions) - Questions and community support

**Before posting:**
1. Check this FAQ
2. Search existing issues/discussions
3. Enable debug logging: `RUST_LOG=debug`
4. Include BoxLite version, platform, and minimal reproduction

### How do I report a bug?

**1. Search existing issues:**
[GitHub Issues](https://github.com/boxlite-ai/boxlite/issues)

**2. Gather information:**
- BoxLite version: `python -c "import boxlite; print(boxlite.__version__)"`
- Platform: `uname -a`
- Python version: `python --version`
- Error message and stack trace

**3. Minimal reproduction:**
```python
import asyncio
import boxlite

async def reproduce():
    # Minimal code that reproduces the issue
    async with boxlite.SimpleBox(image="python:slim") as box:
        result = await box.exec("command")

asyncio.run(reproduce())
```

**4. Debug logs:**
```bash
RUST_LOG=debug python reproduce.py 2>&1 | tee debug.log
```

**5. Create issue:**
- Use bug report template
- Include all gathered information
- Attach debug logs if relevant
- Be specific and clear

### How do I request a feature?

**1. Check roadmap:**
- Review [GitHub Issues](https://github.com/boxlite-ai/boxlite/issues) with `enhancement` label

**2. Search for similar requests:**
- May already be planned or discussed

**3. Create feature request:**
- Use feature request template
- Describe use case (why you need it)
- Provide examples of desired API/behavior
- Explain benefits to other users

**4. Participate in discussion:**
- Respond to questions
- Refine proposal based on feedback
- Consider implementing it yourself (see [CONTRIBUTING.md](../CONTRIBUTING.md))

### How do I contribute?

See [CONTRIBUTING.md](../CONTRIBUTING.md) for:
- Development setup
- Running tests
- Code style guidelines
- Pull request process

**Quick start:**
```bash
git clone https://github.com/boxlite-ai/boxlite.git
cd boxlite
git submodule update --init --recursive
make setup
make dev:python
```

**Areas to contribute:**
- Bug fixes
- Documentation improvements
- New examples
- SDK improvements (Python, Node.js, C)
- Performance optimizations
