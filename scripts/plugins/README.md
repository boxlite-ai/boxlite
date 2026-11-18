# BoxLite plugin distribution and review

The plugin offers Cloud OAuth and Cloud API key over one hosted MCP service, plus an independent local runtime.
Its design is [issue #2535](https://github.com/boxlite-ai/boxlite/issues/2535); user instructions live in [the plugin README](../../plugins/boxlite/README.md).

## Build and validate

Use Python 3.9+ and the repository make targets:

```sh
make plugin:boxlite:check
make plugin:boxlite:dist
make plugin:boxlite:check:cc
```

The Claude check requires `claude` on PATH; it validates both the plugin and marketplace with the native validator.
Unit tests cover the package boundary, both archive formats, and the actual local-launcher subprocess boundary.
They do not prove host OAuth login, a running VM, or directory approval.

| Artifact under `target/plugins` | Use |
| --- | --- |
| `boxlite-0.2.0.zip` | OpenAI plugin ZIP; manifests, one remote MCP, shared skills, local launcher, icon, license |
| `boxlite-marketplace-0.2.0.zip` | Extractable marketplace for native Codex and Claude Code installation |
| `SHA256SUMS` | SHA-256 of both installable archives |

Archive names follow the synchronized manifest version.
The packager uses an exact inventory, fixed ZIP metadata and ordering, and excludes private state and caches.

Claude's directory reads a published GitHub plugin folder; a local marketplace ZIP does not substitute for that repository.

## Real acceptance

Start the acceptance process with `BOXLITE_API_KEY` already supplied by a private environment; never pass the value on argv.
The cloud smoke test creates a small Python Box with inbound access and uploads a synthetic text file.
It exposes a temporary public HTTP app, updates it, and removes the exact created Box.

It also checks nonzero exits, absent IDs, overwrite refusal, and cleanup, and fails if any required check fails.

```sh
make plugin:boxlite:smoke:cloud
```

This bounded test client is maintenance tooling, not a plugin execution path.
The actual plugin always uses the host MCP client for either cloud credential.

The test stores resource IDs and results privately in `target/plugins/evidence/cloud-api.json`; never include that directory in a public package.
On uncertain creation or failed cleanup, inspect the recorded name or ID before running again.

OAuth acceptance must use native host login and the same discovered operations with the resulting OAuth connection.
API-key success cannot stand in for OAuth consent, token refresh, scope denials, or logout.
Check the existing [MCP identity deployment instructions](../../apps/infra/docs/identity-and-mail.md#mcp-client-sign-in) if the issuer does not advertise the supported client-registration mechanism.

Run Local acceptance on a host with usable virtualization, through the packaged launcher and a dedicated runtime home.
Verify create, execution, file roundtrip, localhost serving, update with preserved data, and scoped removal without cloud credentials.
Synthetic child-process tests verify routing isolation but cannot replace that VM test.

```sh
make plugin:boxlite:smoke:local PLUGIN_LOCAL_CLI=/absolute/path/to/verified/boxlite
```

This test invokes the packaged launcher with deliberately conflicting cloud environment settings and a fresh local runtime home.
It runs a small Python VM and verifies a localhost HTTP app, overwrite refusal, and nonzero exits.
It preserves data across updates and restart, then removes its recorded Box.

The test saves a private command transcript in `target/plugins/evidence/local.json`; its runtime home and synthetic files stay under the recorded run directory for diagnosis.
Image downloads use the selected registry; no cloud account or API credential is needed.
