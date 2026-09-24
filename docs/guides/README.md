# Guides

Each guide walks through one task. How the underlying pieces work is in
[Concepts](../concepts/README.md); exact option names and defaults are in
[Reference](../reference/README.md).

## Running boxes

- [Running examples](running-examples.md): nine of the Python examples and what each one shows.
- [Mounting volumes](volumes.md): share host directories with a box for input and output.
- [Configuring networking](networking.md): internet access and port forwarding through gvproxy.
- [Resource limits and tuning](resource-limits.md): size CPU, memory, and disk for a workload.
- [Image registry configuration](image-registry-configuration.md): pull images from private or
  mirrored registries.
- [Guest SSH control](ssh.md): turn the in-guest SSH server on and off.

## Building with BoxLite

- [AI agent integration](ai-agent-integration.md): run agent-generated code safely, with timeouts
  and file transfer.
- [Integration examples](integration-examples.md): expose BoxLite through a web service.
- [Deployment patterns](deployment-patterns.md): a production checklist and common deployment
  shapes.

## When something goes wrong

- [Debugging](debugging.md): enable debug logging and inspect box state.
- [Troubleshooting](troubleshooting.md): causes and fixes for common errors.

## Experimental

These features are release candidates: disabled by default and outside BoxLite's compatibility
guarantees.

- [Custom kernel](custom-kernel.md): boot a box with your own kernel and initramfs.
- [Nested virtualization](nested-virtualization.md): let a workload inside a box start its own
  hardware-accelerated VMs.
