---
name: boxlite
description: Create, operate, deploy to, update, and clean up BoxLite sandboxes using Cloud OAuth, Cloud API key, or an independent local runtime. Use when the user selects BoxLite for execution or hosting.
---

Enter `boxlite-setup` when the mode or connection has not been verified in this session.
Present Cloud OAuth, Cloud API key, and Local if no choice exists, then resume the original task after setup.
Preserve backend, organization, Box identity, and persistent data through updates and diagnosis.

```text
Cloud OAuth -- host token --+
Cloud API key -- user key --+--> same remote MCP --> same Box operations
Local ------------------------> local launcher --> embedded runtime
```

Both cloud modes follow [cloud operations](references/cloud.md) through the selected host MCP connection.
Local follows [local operations](references/local.md) through the independent runtime launcher.

For cloud files, use the current Claude session’s BoxLite upload/download tools or the packaged Codex helper. Pass the selected MCP connection, Box ID and both paths.

For downloads, choose a nonexistent destination and do not create it first; the helper creates it.
Never substitute ad hoc HTTP, another mode, or another account for a failed cloud MCP call.

## Task contract

Identify source, build/start commands, environment variable names, persistent paths, requested resources, and the actual acceptance check.
Reuse existing authorization for costs, data transfer, and cleanup; ask only for missing choices before those actions.
Keep developer credentials outside the app, guest, uploaded files, logs, and recordings.

Inspect live schemas or CLI help; never invent a tool, field, image alias, or URL.
Check errors, completeness, output, and exit status separately; inspect execution state before retrying uncertain writes.
Delete only explicit recorded IDs, and never recreate the Box or destroy data merely to update an app.

## Handoff

Report mode, resource IDs, observed feature results, and stop/remove instructions.
For a public app, verify the returned URL and a real feature; for Local, report the actual localhost endpoint.
State blocked capabilities and unverified steps rather than claiming authentication or deployment succeeded.
