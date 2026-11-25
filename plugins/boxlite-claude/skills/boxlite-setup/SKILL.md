---
name: boxlite-setup
description: Choose and verify BoxLite Cloud OAuth, Cloud API key, or Local mode before operating a Box. Use for onboarding or an explicit mode change, not application end-user login.
---

## Install from a local marketplace

For a local installation, run `make plugin:boxlite:dist` in the BoxLite repository.
Replace `ABSOLUTE_MARKETPLACE_DIRECTORY` with the absolute path to the generated `target/plugins/boxlite-marketplace` directory.

```sh
claude plugin marketplace add ABSOLUTE_MARKETPLACE_DIRECTORY
claude plugin install boxlite@boxlite
```

Start a new session and run `/boxlite:boxlite-setup`.

## Choose a mode

Reuse the user's explicit choice, or present these three options before workload operations:

| Mode | Connection | Requirements |
| --- | --- | --- |
| Cloud OAuth | Host OAuth -> BoxLite MCP | BoxLite account and host authorization |
| Cloud API key | User key -> the same BoxLite MCP | BoxLite API key supplied privately through the host environment |
| Local | Local CLI -> embedded runtime | Shell, compatible CLI, and virtualization; no cloud account |

Both cloud choices use `https://api.boxlite.ai/mcp`, the same tools, and the [cloud workflow](../boxlite/references/cloud.md).
Local is an independent [runtime workflow](../boxlite/references/local.md); never send its work to the cloud.
Never change modes, accounts, organizations, or credential sources to recover from a denial.

Record the choice privately in the project or session, outside Git and plugin files.
A cloud record contains `mode` (`cloud-oauth` or `cloud-api`) and the selected host MCP connection name, never tokens.
Without a writable project, retain the selection in the conversation; OAuth needs no local configuration file.

## Cloud OAuth

If switching from the local API-key configuration below, run `claude mcp remove --scope local boxlite` in the same project and restart Claude Code.
Open `/mcp` and authorize `plugin:boxlite:boxlite` in the browser. Claude manages consent and token storage.

## Cloud API key

Supply `BOXLITE_API_KEY` privately in the environment that launches Claude Code. If it is missing or empty, stop before connecting.
In the project where you use BoxLite, register this local override once:

```sh
claude mcp add-json --scope local boxlite '{"type":"http","url":"https://api.boxlite.ai/mcp","headers":{"Authorization":"Bearer ${BOXLITE_API_KEY}"}}'
```

Keep the single quotes so the saved configuration contains only the variable reference. Restart Claude Code with the key available.
Claude Code gives the local entry precedence over the plugin entry at the same URL. Select `boxlite` in `/mcp` and use its tools.
If the key is rejected, stop and repair the selected credential. When upgrading from the plugin’s API-key setting, supply your key through this environment variable.

## Verify the selected cloud connection

Follow [cloud authentication checks](references/cloud-auth.md) on the selected connection.
Confirm the intended organization and a successful `listBoxes` response before workload operations. An empty authorized list is valid.

Stop on missing credentials or denial. Keep secrets out of chat, logs, and project files.

## Local

Follow [local setup](../boxlite/references/local.md) and verify the runtime on the actual execution host.
Never request cloud login or call cloud tools; disable the unused cloud connection if the host attempts automatic connection.
A web-only host cannot provide Local mode: explain the missing capability and preserve the choice.

## File transfer prerequisites

Cloud file transfer needs Python 3.9+ and host shell/filesystem access.
Claude Code must load the marketplace plugin's registered upload and download tools in the current session.

Use the [file workflow](../boxlite/references/cloud.md#files) to select an existing Codex or Claude MCP connection.
The selected host owns credentials and sends MCP requests; the helper handles local bytes and host-control messages only.

If no programmatic transport is available for that connection, report file transfer unavailable without changing authentication or asking the model to copy base64.

## Continue the task

Report the selected mode, connection or runtime home, and observed setup check; keep sensitive account details private.
Resume the original task with the main `boxlite` skill after setup succeeds.
Installation, discovery, browser consent, and workload execution are separate outcomes.
