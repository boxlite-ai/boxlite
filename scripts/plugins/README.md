# BoxLite plugin distribution and review

The plugin offers Cloud OAuth and Cloud API key over one hosted MCP service, plus an independent local runtime.
Its design is [issue #2535](https://github.com/boxlite-ai/boxlite/issues/2535); user instructions live in [the plugin README](../../plugins/boxlite-claude/README.md).

## Build and validate

Use Python 3.9+ and the repository make targets:

```sh
make plugin:boxlite:submission
make plugin:boxlite:dist
make plugin:boxlite:check:cc
```

The Claude check requires `claude` on PATH; it validates both the plugin and marketplace with the native validator.
Unit tests cover the package boundary, both archive formats, and the actual local-launcher subprocess boundary.
They do not prove host OAuth login, a running VM, or directory approval.

| Artifact under `target/plugins` | Use |
| --- | --- |
| `boxlite-0.2.0.zip` | OpenAI plugin ZIP; root `plugin.json`, one remote MCP, shared skills, local launcher, icon, license |
| `boxlite-marketplace-0.2.0.zip` | Extractable marketplace for native Codex and Claude Code installation |
| `SHA256SUMS` | SHA-256 of both installable archives |

Archive names follow the synchronized manifest version.
The packager uses an exact inventory, fixed ZIP metadata and ordering, and excludes private state and caches.

Claude Directory reads `plugins/boxlite-claude` at the published Git ref. Its native manifest declares an optional sensitive API key.

The OAuth connection has no configured header. The API-key connection uses the same endpoint with the fixed query `?connection=api-key` so Claude discovers both connections.

The release build assembles the Codex ZIP from `plugins/boxlite-codex` and shared files in `plugins/boxlite-claude`. Edit cloud operations and authentication checks once in the Claude source. Each host's setup skill supplies its own connection names and credential configuration.

Only the Codex submission ZIP is uploaded by Actions. The marketplace and archive checksums are optional local outputs. Run `make plugin:boxlite:dist` to generate the local marketplace at `target/plugins/boxlite-marketplace`.

## Publish versioned packages to GHCR

[Build BoxLite plugin packages](../../.github/workflows/build-plugins.yml) validates both host packages and uploads a seven-day Actions artifact.
[Publish BoxLite plugin packages](../../.github/workflows/publish-plugins.yml) runs from `main` after a successful tag build.
It verifies the canonical build, the live tag, and the exact run attempt before taking the registry credential.

```text
plugin tag -> read-only build -> verified artifact -> main-only publisher -> GHCR
```

### First release setup

Complete this setup after the workflows merge and before recreating `boxlite-plugin-v0.2.0`.

1. Disable the legacy Release BoxLite plugin workflow with `gh workflow disable 423888825`. Drain its queued and running jobs before tagging.
2. Create the GitHub Actions environment `boxlite-plugin-ghcr` with a deployment rule for the `main` branch only. Set `GHCR_PUBLISH_USER` and the environment secret `GHCR_PUBLISH_TOKEN` for a dedicated registry writer with a classic `write:packages` token.
3. Have a package administrator reserve `ghcr.io/boxlite-ai/boxlite-plugin` privately under organization package-creation controls. For example, publish a metadata-only `bootstrap` tag with ORAS using an authorized login.
4. Give the publisher access to this package and keep repository Actions tokens out of its write permissions. Verify the writer can publish and the source workflow token cannot write before enabling public downloads.

The workflow requires the package to exist before publishing a version. To keep the account as the only writer, manage access on the package and keep repository permission inheritance disabled.

GHCR starts new packages private. Make the package public after the first verified version so reviewers can pull anonymously. [GitHub package access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

Check that the repository’s Latest Release contains the runtime `install.sh` before and after the cutover. If its pointer is displaced, restore the intended runtime release first.

### Release a plugin version

Update the version in the Codex and Claude manifests. Build the submission and review its contents. Actions builds the ZIP from the tagged source and the publisher uses that build attempt’s uploaded ZIP.

After the change merges, tag the intended commit on `main` and push the tag. For example, if the manifests contain version `0.2.0`:

```sh
make plugin:boxlite:submission
git tag boxlite-plugin-v0.2.0
git push origin boxlite-plugin-v0.2.0
```

The publisher stores the verified Codex ZIP in one OCI artifact at `ghcr.io/boxlite-ai/boxlite-plugin:0.2.0`.
Retry a failed build by rerunning the read-only workflow on the matching tag:

```sh
gh workflow run build-plugins.yml --ref boxlite-plugin-v0.2.0
```

After an interrupted push, a retry can attest an identical artifact without replacing it. A different manifest at the same version stops the run.

Use the new build workflow on tags created after the migration. Historical GitHub Release links, if any, retain their original files.

### Download and verify

Resolve the artifact by version and verify the publisher's signed build commit against the Git tag. The same attestation records the build run ID and attempt. Use [ORAS](https://oras.land/docs/installation/), GitHub CLI, and `jq`.

```sh
(
  set -eu
  image=ghcr.io/boxlite-ai/boxlite-plugin
  version=0.2.0
  digest="$(oras resolve "$image:$version")"
  reference="$image@$digest"
  commit="$(gh api "repos/boxlite-ai/boxlite/commits/tags%2Fboxlite-plugin-v$version" --jq .sha)"
  provenance="$(gh attestation verify "oci://$reference" --repo boxlite-ai/boxlite \
    --signer-workflow boxlite-ai/boxlite/.github/workflows/publish-plugins.yml \
    --source-ref refs/heads/main --format json \
    --predicate-type https://boxlite.ai/attestations/plugin-build-source/v1)"
  printf '%s\n' "$provenance" | jq -es --arg commit "$commit" '
    length == 1 and any(.[0][].verificationResult.statement.predicate;
      .commit == $commit and (.runId | test("^[1-9][0-9]*$"))
      and (.runAttempt | test("^[1-9][0-9]*$")))'
  manifest="$(oras manifest fetch "$reference")"
  printf '%s\n' "$manifest" |
    jq -es --arg version "$version" --arg commit "$commit" '
      length == 1 and .[0].annotations["org.opencontainers.image.version"] == $version
      and .[0].annotations["org.opencontainers.image.revision"] == $commit'
  oras pull "$reference" --output "boxlite-plugin-$version"
  cd "boxlite-plugin-$version"
  zip="boxlite-$version.zip"
  checksum="$(printf '%s\n' "$manifest" | jq -er --arg zip "$zip" '
    .layers | select(length == 1) | .[0]
    | select(.annotations["org.opencontainers.image.title"] == $zip)
    | .digest | capture("^sha256:(?<hex>[0-9a-f]{64})$").hex')"
  printf '%s  %s\n' "$checksum" "$zip" | sha256sum --check
)
```

Run the commands in order and stop if a verification fails. On macOS, use `shasum -a 256 -c` for the checksum command.

If the version tag moves, find retained digests, including untagged entries. [Package Versions](https://github.com/orgs/boxlite-ai/packages/container/boxlite-plugin/versions)

Resume the verification with a candidate digest and use it only when the signed build commit and manifest annotations match.

Publishing packages preserves the existing OpenAI submission and Claude directory review steps.

## Real acceptance

Start the acceptance process with `BOXLITE_API_KEY` already supplied by a private environment; never pass the value on argv.
The cloud smoke test creates a small Python Box with inbound access and uploads a synthetic text file.
It exposes a temporary public HTTP app, updates it, and removes the exact created Box.

It also checks nonzero exits, absent IDs, and cleanup, and fails if any required check fails.

```sh
make plugin:boxlite:smoke:cloud
```

This bounded test client is for maintenance.

The Codex helper and the current Claude session’s BoxLite tools supply the transfer arguments. The host calls existing `uploadFiles` and `downloadFiles`.

The helper handles archive base64 inside the program and prints completion metadata. It adds no checksum or upload readback.

The [design](https://github.com/boxlite-ai/boxlite/issues/2928) and [usage contract](../../plugins/boxlite-claude/skills/boxlite/references/cloud.md#files) describe both host adapters.
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

## Directory submission

Submit the standalone Codex ZIP to OpenAI and the repository path `plugins/boxlite-claude` to Claude Directory.
Keep reviewer credentials in each portal's private access fields; do not include credentials, private organization IDs, or raw host transcripts in the ZIP.

OpenAI's portal currently supports OAuth connection setup, not API-key onboarding; native hosts configure API keys separately.
Confirm eligibility for optional local execution before making a combined public-listing claim.
Claude requires companion plugin and connector listings, and its connector review covers all exposed server tools.

References: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [OpenAI local execution](https://developers.openai.com/plugins/deploy/desktop-only), [Claude publishing](https://claude.com/docs/directory/publish), [Claude connector review](https://claude.com/docs/connectors/building/review-criteria).

## Transfer rollout

No BoxLite API or MCP server deployment is required; the helper uses existing file tools.
Codex requires an installed app-server exposing `mcpServer/tool/call` and the selected server in its loaded configuration.

Claude Code requires plugin tool registration and a post-permission `tool.run` handler. The handler calls the selected MCP connection directly after the session authorizes the transfer.

Build the artifacts with `make plugin:boxlite:dist`. The marketplace includes the Claude module and its Python worker. The standalone submission ZIP contains the Codex helper.

Keep marketplace eligibility, deployed OAuth acceptance and API-key acceptance separate in release evidence.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Code mods](https://code.claude.com/docs/en/plugins/mods), [programmatic MCP data handling](https://www.anthropic.com/research/code-execution-with-mcp).
