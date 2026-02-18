# 03 Lifecycle

Box lifecycle management: start, stop, restart, detach, and cross-process
sharing.

| File | Description |
|------|-------------|
| `manage_lifecycle.py` | Stop, restart, resource monitoring, named persistent boxes |
| `detach_and_reattach.py` | Detach a box and reattach from the same process |
| `shutdown_runtime.py` | Graceful runtime shutdown |
| `share_across_processes.py` | Create a box in one process, attach from another |

**Recommended first example:** `manage_lifecycle.py`
