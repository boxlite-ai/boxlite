---
name: boxlite-setup
description: Choose and verify BoxLite Cloud OAuth, Cloud API key, or Local mode before operating a Box. Use for onboarding or an explicit mode change, not application end-user login.
---

## Choose a mode

Reuse the user's explicit choice, or present these three options before workload operations:

| Mode | Connection | Requirements |
| --- | --- | --- |
| Cloud OAuth | Host OAuth -> BoxLite MCP | BoxLite account and host authorization |
| Cloud API key | User key -> the same BoxLite MCP | User-supplied key and private host MCP configuration |
| Local | Local CLI -> embedded runtime | Shell, compatible CLI, and virtualization; no cloud account |

Both cloud choices use `https://api.boxlite.ai/mcp`, the same tools, and the [cloud workflow](../boxlite/references/cloud.md).
Local is an independent [runtime workflow](../boxlite/references/local.md); never send its work to the cloud.
Never change modes, accounts, organizations, or credential sources to recover from a denial.

Record the choice privately in the project or session, outside Git and plugin files.
A cloud record contains `mode` (`cloud-oauth` or `cloud-api`) and the selected host MCP connection name, never tokens.
Without a writable project, retain the selection in the conversation; OAuth needs no local configuration file.

## Cloud OAuth

For first use, have the user complete BoxLite registration in the Dashboard, including email verification and a default organization.
An existing Dashboard account can sign in even when its MCP token contains no profile claims; direct first-time registration from MCP is not promised.

Use the bundled `boxlite` MCP connection and the host's OAuth UI.
Let the host open the browser, obtain consent, and store tokens; never implement login or read the host's token store.

If unavailable, report the exact setup step and wait for authorization rather than installing a CLI or requesting an API key.
Client-registration errors happen before user login: report the issuer/client setup blocker without asking the user to reset a password.

If the API returns `email_required` or `registration_required`, direct the user to complete Dashboard registration with the same identity, then retry explicitly.
If no default organization exists, stop and have the user complete organization setup; never choose another account or organization automatically.

Discover tools and read their schemas, then call `listBoxes` for the selected organization.
Check `isError` and the response; an empty authorized list is valid, but discovery or HTTP 401 is not successful login.
Confirm the intended organization before writes, then resume the original task.

## Cloud API key

Follow [native host setup](references/cloud-auth.md); only authentication differs from OAuth.
Require the user to supply a key to the host explicitly through their chosen private secret environment.
Never put credentials in plugin files, argv, chat, screenshots, or application archives.

Check that the selected key reference is nonempty without printing its value before discovering or calling tools.
Refuse a missing or empty key even if OAuth is cached; if the host cannot enforce that separation, report API-key mode unavailable.
Use only the selected API-key MCP connection, verify identity and organization, then follow the shared cloud workflow.

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
