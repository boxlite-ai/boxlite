# BoxLite plugin distribution

The plugin offers Cloud OAuth and Cloud API key through one hosted MCP service, plus an independent local runtime.
The workflow is documented in [the plugin README](../../plugins/boxlite/README.md).

## Build and validate

Use Python 3.9+ and the repository make targets:

```sh
make plugin:boxlite:check
make plugin:boxlite:dist
```

The check validates synchronized host manifests, the exact package inventory, and local routing isolation.
The distribution target generates a plugin ZIP and a standalone marketplace ZIP under `target/plugins`, with SHA-256 checksums.
Archives use fixed metadata and ordering; private evidence, credentials, and caches are excluded.

Install the extracted marketplace with the native host commands in the plugin README.
The installed skills preserve the selected backend, use host-managed credentials for cloud work, and use the guarded launcher for Local.
Package checks do not prove OAuth availability, real VM execution, or public directory approval.
