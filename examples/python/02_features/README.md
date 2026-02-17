# 02 Features

Individual BoxLite features demonstrated in isolation.

| File | Description |
|------|-------------|
| `set_cmd_and_user.py` | Override image CMD/ENTRYPOINT and run as a non-root user |
| `forward_ports.py` | Map host ports to container ports |
| `copy_files.py` | Copy files in/out of a box (includes tmpfs workaround, async + sync) |
| `use_custom_registry.py` | Pull images from custom registries (ghcr.io, quay.io, etc.) |
| `use_local_oci_bundle.py` | Run a pre-extracted OCI bundle without pulling |

**Recommended first example:** `forward_ports.py`
