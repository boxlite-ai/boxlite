# Getting Started

Get up and running with BoxLite in 5 minutes.

## Prerequisites

### System Requirements

BoxLite requires a platform with hardware virtualization support:

| Platform       | Architecture  | Requirements                        |
|----------------|---------------|-------------------------------------|
| macOS          | Apple Silicon | macOS 12+ (Monterey or later)       |
| Linux          | x86_64        | KVM enabled (`/dev/kvm` accessible) |
| Linux          | ARM64         | KVM enabled (`/dev/kvm` accessible) |
| Windows (WSL2) | x86_64        | WSL2 with KVM support               |

**Not Supported:**
- macOS Intel (x86_64) - Hypervisor.framework stability issues

### Verify Virtualization Support

**macOS:**
```bash
# Check macOS version (should be 12+)
sw_vers

# Check architecture (should be arm64)
uname -m
```

**Linux:**
```bash
# Check if CPU supports virtualization (should show vmx or svm)
grep -E 'vmx|svm' /proc/cpuinfo

# Check if KVM is available (should exist and be accessible)
ls -l /dev/kvm

# If /dev/kvm doesn't exist, load KVM module
sudo modprobe kvm
sudo modprobe kvm_intel  # For Intel CPUs
sudo modprobe kvm_amd    # For AMD CPUs

# Add user to kvm group (may require logout/login)
sudo usermod -aG kvm $USER
```

**Windows (WSL2):**
```bash
# Verify you're running WSL2 (should show "2")
wsl.exe -l -v

# Check if KVM is available
ls -l /dev/kvm

# Add user to kvm group
sudo usermod -aG kvm $USER

# Apply the new group membership (pick one):
newgrp kvm
# OR restart WSL from Windows PowerShell:
# wsl.exe --shutdown

# Verify group membership
id -nG | tr ' ' '\n' | grep -x kvm

# Verify KVM access
python3 -c "open('/dev/kvm','rb').close(); print('kvm ok')"
```

**Note:** If you see "Timeout waiting for guest ready (30s)" errors, it's likely a KVM permission issue. Ensure your user is in the `kvm` group and restart WSL with `wsl.exe --shutdown`.

### No Daemon Required

Unlike Docker, BoxLite doesn't require a daemon process. It's an embeddable library that runs directly in your application.

## Choose Your SDK

| SDK | Language/Toolchain | Best For |
|-----|--------------------|----------|
| **[Python](./quickstart-python.md)** | Python 3.10+ | AI agents, scripting, rapid prototyping |
| **[Node.js](./quickstart-nodejs.md)** | Node.js 18+ | Web services, TypeScript projects |
| **[Rust](./quickstart-rust.md)** | Rust 1.88+ | Performance-critical, embedded systems |
| **[C](./quickstart-c.md)** | C11-compatible compiler (GCC/Clang) | C/C++ applications, system integration |
| Go | Coming soon | — |

## Next Steps

### Learn More

- **[Architecture](../architecture/README.md)** - How BoxLite works under the hood
- **[How-to Guides](../guides/README.md)** - Practical usage guides
- **[Reference](../reference/README.md)** - Complete API documentation
- **[FAQ](../faq.md)** - Common questions and answers

### Get Help

- **[GitHub Issues](https://github.com/boxlite-labs/boxlite/issues)** - Bug reports and feature requests
- **[GitHub Discussions](https://github.com/boxlite-labs/boxlite/discussions)** - Questions and community support

### Contribute

- **[CONTRIBUTING.md](../../CONTRIBUTING.md)** - Contribution guidelines

## Troubleshooting

### Installation Issues

**Problem:** `pip install boxlite` fails

**Solutions:**
- Verify Python 3.10+: `python --version`
- Update pip: `pip install --upgrade pip`
- Check platform support (macOS ARM64, Linux x86_64/ARM64 only)

### Runtime Issues

**Problem:** "KVM not available" error on Linux

**Solutions:**
```bash
# Check KVM module
lsmod | grep kvm

# Load KVM module
sudo modprobe kvm kvm_intel  # or kvm_amd

# Check /dev/kvm permissions
ls -l /dev/kvm
sudo chmod 666 /dev/kvm  # or add user to kvm group
```

**Problem:** Box fails to start

**Solutions:**
- Check disk space: `df -h ~/.boxlite`
- Enable debug logging: `RUST_LOG=debug python script.py`
- Verify image name: Try `docker pull <image>` to test
- Check hypervisor: Ensure KVM (Linux) or Hypervisor.framework (macOS) is available

### Performance Issues

**Problem:** Box is slow

**Solutions:**
```python
# Increase resource limits
boxlite.BoxOptions(
    cpus=4,          # More CPUs
    memory_mib=4096, # More memory
)

# Check metrics
metrics = await box.metrics()
print(f"Memory: {metrics.memory_usage_bytes / (1024**2):.2f} MB")
```

For more troubleshooting help, see [FAQ & Troubleshooting](../faq.md).
