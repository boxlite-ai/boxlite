# 07 Advanced

Low-level APIs, FUSE filesystem, and multi-box orchestration.

| File / Directory | Description |
|------------------|-------------|
| `use_native_api.py` | Direct Rust API: custom runtimes, resource limits, streaming |
| `use_native_api_sync.py` | Same as above, synchronous API |
| `fuse/` | Mount a FUSE filesystem inside a box |
| `multi_agent/` | Point-to-point and pub/sub messaging between boxes |
| `ai_pipeline/` | Coder-Reviewer-Tester pipeline across three VMs |

**Recommended first example:** `use_native_api.py`
