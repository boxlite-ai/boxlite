# BoxLite plugin v0.2

Choose **Cloud OAuth**, **Cloud API key**, or **Local** when you first use BoxLite.
Both cloud modes share the same hosted MCP service and operations; Local runs the independent embedded runtime on your machine.
The plugin preserves your choice rather than switching backends when authentication or execution fails.

| Choice | How it works | Availability |
| --- | --- | --- |
| Cloud OAuth | Host manages browser authorization and tokens; calls `https://api.boxlite.ai/mcp` | Hosts with remote MCP OAuth |
| Cloud API key | Host supplies your key to the same MCP endpoint and tools | Native hosts supporting private MCP configuration |
| Local | Bundled launcher invokes your local BoxLite CLI, with cloud routing removed | Shell, Python 3.9+, supported CLI, and usable virtualization |

## Install

For versioned marketplace ZIPs, use the [GHCR download and verification guide](https://github.com/boxlite-ai/boxlite/blob/main/scripts/plugins/README.md#download-and-verify).

Extract the standalone marketplace ZIP, then use its absolute directory:

```sh
codex plugin marketplace add ABSOLUTE_MARKETPLACE_DIRECTORY
codex plugin add boxlite@boxlite
```

For Claude Code:

```sh
claude plugin marketplace add ABSOLUTE_MARKETPLACE_DIRECTORY
claude plugin install boxlite@boxlite
```

Start a new session and ask: **Set up BoxLite and let me choose Cloud OAuth, Cloud API key, or Local.**
Claude Code also supports `/boxlite:boxlite-setup` and `/boxlite:boxlite`.
An explicit request such as **Run hello locally with BoxLite** selects Local directly.

## Use

[Setup](skills/boxlite-setup/SKILL.md) verifies your chosen connection, then [operations](skills/boxlite/SKILL.md) resumes your original task.
Cloud work uses discovered MCP tools; the packaged file helper calls `uploadFiles` and `downloadFiles` with base64 handled entirely by programs.
Select Codex or Claude and an already configured host connection; the helper passes data over local pipes without reading credentials or contacting BoxLite.

See [file transfer](skills/boxlite/references/cloud.md#files) for commands and connection prerequisites.
[API-key setup](skills/boxlite-setup/references/cloud-auth.md) uses the host's private credential reference, never a token bundled in the plugin.

[Local setup](skills/boxlite/references/local.md) pins a dedicated runtime home and clears inherited cloud routing.
Linux needs accessible KVM; macOS needs Apple Silicon and Hypervisor.framework.
Local services use verified localhost ports and do not receive a cloud HTTPS URL.

OAuth permissions currently exclude tunnels and network configuration, so OAuth cannot create a new public app URL.
For first OAuth use, complete registration in the BoxLite Dashboard with the same identity, verify email, and establish a default organization.
Direct first-time account creation from an MCP token without email is unsupported; existing accounts reuse their stored profile.

API-key permissions remain those granted to the key; a denial never triggers an automatic credential or mode change.
Box updates retain the same identity and data, and cleanup targets only explicit authorized IDs.

## Data and credentials

The plugin sends requested cloud tool arguments, commands and files to the selected BoxLite deployment.
Local runs the CLI on your execution host; runtime image pulls and commands you request may access their selected registries or networks.
There is no plugin telemetry, background service, bundled credential store, or installation hook.

The file helper reads reviewed sources and writes requested downloads; it requires Python and host filesystem access.
One plugin package supports both hosts.
The helper uses existing MCP contracts without a BoxLite CLI dependency, new server API, transfer cache or additional checksum/readback step.

Both hosts own their MCP connections and credentials; Claude adds one model request per file operation.

Claude's model request includes the tool name, Box ID and remote path. A placeholder represents the upload archive.

Claude uses a private persistent session for downloads, so its transcripts or saved result files can retain downloaded data.

OAuth credentials stay with the host; API keys stay in the user's chosen private host environment.
Keep mode selection, Box IDs, runtime homes, and app secrets outside the plugin and version control.
Only upload reviewed source, excluding developer credentials, private state, caches, and unrequested persistent data.

## Upgrade, uninstall, and rollback

Upgrade through the selected host marketplace and start a new session; verify mode, identity, and existing Box IDs before writes.
Version 0.1 cloud CLI deployment helpers have been replaced by shared cloud MCP instructions; retain existing app data and migrate setup explicitly.
Old private deployment configurations are not automatically executed or deleted.

Remove `boxlite@boxlite` through the host plugin manager to uninstall.
Remove any separately configured `boxlite-api` connection and revoke its credential only when intended; plugin uninstall does not delete Boxes or local homes.
To roll back, install a retained verified package version, recheck its supported workflow, and preserve application data.

## Public directory status

These files are a release candidate, not evidence of an approved public listing.
OpenAI's public submission connection is OAuth; API-key setup currently requires a supported native host, and optional local execution needs platform eligibility review.
The packaged file transfer script calls the existing remote MCP tools through the selected host.

A dedicated host process reloads existing configuration; it does not attach to the current interactive session.
Native API-key acceptance does not establish OAuth file-transfer acceptance.
The same package targets both clients; directory review must still confirm the execution surface and publisher eligibility.

Claude distribution requires the plugin repository plus a companion listing for the same hosted MCP service.

See [release and review instructions](https://github.com/boxlite-ai/boxlite/blob/main/scripts/plugins/README.md) for artifact generation and unresolved acceptance gates.
Public links: [website](https://boxlite.ai), [support](https://boxlite.ai/contact), [privacy](https://boxlite.ai/legal/privacy), [terms](https://boxlite.ai/legal/terms).
