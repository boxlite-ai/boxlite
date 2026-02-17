# BoxLite Python SDK Examples

Categorized examples from beginner to advanced.  Each subdirectory has its own
README with a quick summary.

## Directory Index

| Directory | What it covers |
|-----------|----------------|
| [`01_getting_started/`](01_getting_started/) | SimpleBox, CodeBox, sync variants, listing boxes |
| [`02_features/`](02_features/) | CMD/user overrides, port forwarding, file copy, registries, OCI bundles |
| [`03_lifecycle/`](03_lifecycle/) | Stop/restart, detach/reattach, shutdown, cross-process sharing |
| [`04_interactive/`](04_interactive/) | Interactive shell, Claude Code install in a terminal |
| [`05_browser_desktop/`](05_browser_desktop/) | Playwright, Puppeteer, desktop automation |
| [`06_ai_agents/`](06_ai_agents/) | LLM-driven boxes, SkillBox, Claude chat, Starbucks agent, OpenClaw |
| [`07_advanced/`](07_advanced/) | Native Rust API, FUSE filesystem, multi-agent orchestration, AI pipeline |

## Quick Start

```bash
# Install BoxLite
pip install boxlite

# Run the simplest example
python examples/python/01_getting_started/run_simplebox.py
```

### For Developers (Working in the Repo)

```bash
# Build the SDK
cd sdks/python && pip install -e . && cd ../..

# Run examples
python examples/python/01_getting_started/run_simplebox.py
```

## Shared Utilities

[`_helpers.py`](_helpers.py) contains `setup_logging()` used across examples.
Each example has a fallback so it can also run standalone when copied out of this
directory.

## Tips

1. **First Run**: Image pulls may take time. Subsequent runs are faster.

2. **Resource Limits**: Adjust `memory_mib` and `cpus` based on your system:
   ```python
   box = boxlite.SimpleBox(
       image='alpine:latest',
       memory_mib=512,
       cpus=1
   )
   ```

3. **Error Handling**: Always use async context managers for cleanup:
   ```python
   async with boxlite.SimpleBox(image='alpine:latest') as box:
       result = await box.exec('echo', 'hello')
   ```

4. **Logging**: Enable debug logging to troubleshoot:
   ```python
   import logging
   logging.basicConfig(level=logging.DEBUG)
   ```

## Troubleshooting

**"BoxLite runtime not found"**
- Run `pip install boxlite` or `pip install -e .` from `sdks/python`

**"Image not found"**
- BoxLite will auto-pull images on first use
- Ensure you have internet connectivity

**"Permission denied" on Linux**
- Check KVM access: `ls -l /dev/kvm`
- Add user to kvm group: `sudo usermod -aG kvm $USER`

**"UnsupportedEngine" on macOS Intel**
- Intel Macs are not supported; use Apple Silicon or Linux with KVM

## Next Steps

- [Python SDK README](../../sdks/python/README.md) - Full API documentation
- [Architecture](../../docs/architecture/README.md) - How BoxLite works
- [Project README](../../README.md) - Overview
