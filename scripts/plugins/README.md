# BoxLite plugin distribution and review

The plugin offers Cloud OAuth and Cloud API key over one hosted MCP service, plus an independent local runtime.
Its design is [issue #2535](https://github.com/boxlite-ai/boxlite/issues/2535); user instructions live in [the plugin README](../../plugins/boxlite/README.md).

## Build and validate

Use Python 3.9+ and the repository make targets:

```sh
make plugin:boxlite:check
make plugin:boxlite:dist
make plugin:boxlite:check:cc
make plugin:boxlite:review-kit
make plugin:boxlite:ready
```

The Claude check requires `claude` on PATH; it validates both the plugin and marketplace with the native validator.
Unit tests cover the package boundary, both archive formats, and the actual local-launcher subprocess boundary.
They do not prove host OAuth login, a running VM, or directory approval.

| Artifact under `target/plugins` | Use |
| --- | --- |
| `boxlite-0.2.0.zip` | OpenAI plugin ZIP; manifests, one remote MCP, shared skills, local launcher, icon, license |
| `boxlite-marketplace-0.2.0.zip` | Extractable marketplace for native Codex and Claude Code installation |
| `SHA256SUMS` | SHA-256 of both installable archives |
| `boxlite-review-kit-0.2.0.zip` | Both archives, checksums, listing text, reviewer instructions, cases, and readiness checklist |
| `boxlite-review-kit-0.2.0.zip.sha256` | Checksum of the complete handoff archive |

Archive names follow the synchronized manifest version.
The packager uses an exact inventory, fixed ZIP metadata and ordering, and excludes private state and caches.

The review kit is a handoff archive, not the ZIP to upload as an OpenAI plugin.
Claude's directory reads a published GitHub plugin folder; a local marketplace ZIP does not substitute for that repository.

## Publish versioned GitHub Releases

The [Release BoxLite plugin workflow](../../.github/workflows/release-plugins.yml) publishes all five files listed above as GitHub Release assets.
Its independent tag format is `boxlite-plugin-vVERSION`, for example `boxlite-plugin-v0.2.1`; runtime/SDK tags do not publish plugins.
PRs only build and validate a preview, using read-only repository permissions.

```text
plugin version + matching tag -> tests and native validator -> draft with five assets -> published Release
```

1. Update `plugins/boxlite/plugin.json`, both host manifests, and the `version` in `scripts/plugins/review/{cases,checklist}.json` together.
2. Update versioned filenames in docs and package tests, then run `make plugin:boxlite:check:cc plugin:boxlite:review-kit`.
3. Commit the version change and push an unused matching tag to the intended release commit.

For example, after preparing version `0.2.1` at the current commit:

```sh
git tag boxlite-plugin-v0.2.1
git push origin boxlite-plugin-v0.2.1
```

The tag push builds from that commit, installs the pinned Claude validator, validates both host manifests, and verifies archive checksums.
The publish job rechecks those hashes and the remote tag's commit before uploading; only this job has `contents: write`.
It uses the repository `GITHUB_TOKEN`, needs no cloud/model credentials, and does not mark the plugin as the repository's Latest release.

Before the first plugin release, explicitly mark the intended runtime release as Latest in GitHub.
GitHub can otherwise ignore `--latest=false` and automatically select the plugin; see the [upstream report](https://github.com/orgs/community/discussions/151811).
Verify `/releases/latest` still names a runtime release after publishing.

Download the ZIPs and checksums from the matching entry in [GitHub Releases](https://github.com/boxlite-ai/boxlite/releases).
Release assets remain available independently of the seven-day Actions artifact used for job handoff and PR previews.
Those temporary artifacts include version, run ID and attempt in their names, so reruns cannot overwrite earlier previews.

Existing releases, including drafts, cause publication to fail without replacing their assets.
If an upload fails, inspect the incomplete draft before explicitly deleting it and retrying; never delete a published version to reuse its number.

After this workflow is present on `main`, a failed tag run can also be retried manually with:

```sh
gh workflow run release-plugins.yml --ref boxlite-plugin-v0.2.1
```

A manual run on a branch, or a tag that disagrees with the plugin manifest, fails before publication.
Publishing these build artifacts does not submit to OpenAI/Claude or complete the private release-readiness checklist.

## Real acceptance

Start the acceptance process with `BOXLITE_API_KEY` already supplied by a private environment; never pass the value on argv.
The cloud smoke test creates a small Python Box with inbound access and uploads a synthetic text file.
It exposes a temporary public HTTP app, updates it, and removes the exact created Box.

It also checks nonzero exits, absent IDs, and cleanup, and fails if any required check fails.

```sh
make plugin:boxlite:smoke:cloud
```

This bounded test client is maintenance tooling, not a plugin execution path.
The plugin file helper supplies arguments to Codex app-server or Claude permission callbacks; the host calls existing `uploadFiles` and `downloadFiles`.
It handles archive base64 inside the program and prints only completion metadata, without hooks, checksums or upload readback.

The [design](https://github.com/boxlite-ai/boxlite/issues/2928) and [usage contract](../../plugins/boxlite/skills/boxlite/references/cloud.md#files) describe both host adapters.
`make test:unit:plugins` exercises local filesystem and host subprocess boundaries; its peers are fixtures.
Native-host and deployed-server acceptance are separate from those tests.

The test stores resource IDs and results privately in `target/plugins/evidence/cloud-api.json`; never include that directory in a public package.
On uncertain creation or failed cleanup, inspect the recorded name or ID before running again.

OAuth acceptance must use native host login and the same discovered operations with the resulting OAuth connection.
API-key success cannot stand in for OAuth consent, token refresh, scope denials, or logout.
Check the existing [MCP identity deployment instructions](../../apps/infra/docs/identity-and-mail.md#mcp-client-sign-in) if the issuer does not advertise the supported client-registration mechanism.

Run `make plugin:boxlite:preflight:oauth` without credentials to check public metadata and the unauthenticated 401 challenge.
Its private report distinguishes public prerequisites from unverified client registration, native login, and workload permissions.

It exits nonzero for missing prerequisites; it never changes Auth0 or reads host credentials.
The [OAuth runbook](review/OAUTH.md), included in the review kit, separates local contract tests, operator configuration, first-account setup, and native acceptance.

First-time users complete Dashboard registration before connecting with the same identity; MCP-only registration without email is not supported by this candidate.

Run Local acceptance on a host with usable virtualization, through the packaged launcher and a dedicated runtime home.
Verify create, execution, file roundtrip, localhost serving, update with preserved data, and scoped removal without cloud credentials.
Synthetic child-process tests verify routing isolation but cannot replace that VM test.

```sh
make plugin:boxlite:smoke:local PLUGIN_LOCAL_CLI=/absolute/path/to/verified/boxlite
```

This test invokes the packaged launcher with deliberately conflicting cloud environment settings and a fresh local runtime home.
It runs a small Python VM and verifies a localhost HTTP app, file roundtrips, and nonzero exits.
It preserves data across updates and restart, then removes its recorded Box.

The test saves a private command transcript in `target/plugins/evidence/local.json`; its runtime home and synthetic files stay under the recorded run directory for diagnosis.
Image downloads use the selected registry; no cloud account or API credential is needed.

## Release gate

Copy [review/checklist.json](review/checklist.json) outside version control and attach the actual evidence for every gate.
Run `make plugin:boxlite:ready PLUGIN_REVIEW_CHECKLIST=/absolute/private/checklist.json` against that copy.
The default checklist intentionally fails closed; generating packages does not mark gates complete.

The [reviewer runbook](review/REVIEWER.md) and [eight submission cases](review/cases.json) explain what to submit and exercise.
Keep reviewer credentials in each portal's private access fields; do not include credentials, private organization IDs, or raw host transcripts in the ZIP.
The release owner must verify each evidence reference against the exact archive hashes before changing a gate to `passed`.

OpenAI's portal currently supports OAuth connection setup, not API-key onboarding; native hosts configure API keys separately.
Confirm eligibility for optional local execution before making a combined public-listing claim.
Claude requires companion plugin and connector listings, and its connector review covers all exposed server tools.

References: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [OpenAI local execution](https://developers.openai.com/plugins/deploy/desktop-only), [Claude publishing](https://claude.com/docs/directory/publish), [Claude connector review](https://claude.com/docs/connectors/building/review-criteria).

## Transfer rollout

No BoxLite API or MCP server deployment is required; the helper uses existing file tools.
Codex requires an installed app-server exposing `mcpServer/tool/call` and the selected server in its loaded configuration.
Claude requires its permission control channel and raw structured tool events; each operation adds one model request.

Both adapters start dedicated host processes using existing configuration; neither reads credentials or implements MCP transport.
No live interactive socket is reused and no credential fallback occurs.

Build the single distributable with `make plugin:boxlite:dist`; it contains no lifecycle hooks.
Keep marketplace eligibility, deployed OAuth acceptance and API-key acceptance separate in release evidence.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude permission callbacks](https://code.claude.com/docs/en/agent-sdk/user-input), [programmatic MCP data handling](https://www.anthropic.com/research/code-execution-with-mcp).
