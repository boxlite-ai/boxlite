# Shared cloud operations

Both cloud authentication modes use `https://api.boxlite.ai/mcp`, the same discovered tools, and this workflow.
Only the credential and its granted permissions differ. Lifecycle and execution use native MCP; the packaged file helper calls the existing MCP file tools programmatically.

## Create and execute

Discover lifecycle, execution, and file tools and read their live schemas before calling them.
Use catalog discovery for additional operations; the following is an example shape, not a successful-call claim:

```json
{"body":{"name":"hello-demo","image":"python","cpus":1,"memory_mib":512}}
```

Catalog discovery names an `invocationTool` for each operation: use `read_api_endpoint` for GET/HEAD/OPTIONS and `write_api_endpoint` for modifying operations.
Use only the tool actually advertised by the connected server; a class mismatch is an error, never a reason to switch credentials.
The old mixed catalog invoker is superseded; report an outdated server if the required split tools are unavailable.

Use the ID returned by `createBox` in `startExecution`:

```json
{"box_id":"RETURNED_ID","body":{"command":"python3","args":["-c","print('hello')"],"timeout_seconds":30},"wait":true,"wait_timeout_seconds":60}
```

Require false `isError`, true `complete`, zero `exit_code`, and the expected output.
A guest failure can arrive through successful MCP transport; report it accurately.
For incomplete output, retain the execution ID and inspect `getExecution`; never repeat a write blindly.

## Files

Use the packaged `scripts/transfer.py` helper for cloud files.
It prepares archive arguments and hands them to the installed host, which sends the existing `uploadFiles` and `downloadFiles` calls.
The helper never reads tokens or sends HTTP/MCP requests to BoxLite; do not copy, rewrite or split base64 in a conversation.

```text
model selects files and paths -> helper packs bytes -> host client calls existing MCP tool
host returns raw tool result -> helper decodes files -> model receives short receipt
```

The host needs Python 3.9+, shell/filesystem access, and an already configured and authorized MCP connection.
Resolve `SKILL_DIR` to this installed skill and use the exact Box ID from the selected cloud connection.
Select the host and connection explicitly; failures never switch credentials or fall back to REST or BoxLite CLI.

| Host | Data handoff | Requirement and cost |
| --- | --- | --- |
| `codex` | Local app-server `mcpServer/tool/call` | Installed Codex with this method; no additional model request |
| `claude` | Blocking execution hook with `updatedInput` and raw `structuredContent` event | Claude Code with blocking `PreToolUse` callback support; one additional model request per operation |

Use the actual configured server name, not a tool namespace guessed from its display label:

```sh
python3 SKILL_DIR/scripts/transfer.py --host codex --server SELECTED_SERVER upload --box BOX_ID --source /absolute/reviewed-source --destination /workspace/new-release
python3 SKILL_DIR/scripts/transfer.py --host codex --server SELECTED_SERVER download --box BOX_ID --source /workspace/new-release/. --destination /absolute/new-download
python3 SKILL_DIR/scripts/transfer.py --host claude --server SELECTED_SERVER upload --box BOX_ID --source /absolute/reviewed-source --destination /workspace/new-release
python3 SKILL_DIR/scripts/transfer.py --host claude --server SELECTED_SERVER download --box BOX_ID --source /workspace/new-release/. --destination /absolute/new-download
```

Each adapter starts a dedicated host process that reloads existing configuration; it does not attach to the running interactive session.
A connection supplied only through flags on another process is not automatically inherited.
For Claude, pass an existing `--mcp-config /absolute/private-config.json` or `--plugin-dir /absolute/plugin` when needed; only Claude reads those files.

Claude's single model turn proposes the selected tool and a placeholder, never archive bytes.
The helper sends the prompt only after Claude confirms the execution hook was registered and blocks on failure.
The hook checks the exact tool, connection, Box, path and input, then supplies the program-generated arguments for that call once.

Claude still applies host deny and ask rules. If a rule asks, the helper checks the guarded call ID and exact arguments before responding.

Downloads use Claude's raw structured result or its complete saved JSON when large results omit that field.
Saved results must belong to the actual child session under Claude's projects directory; arbitrary paths and symlinks are refused.
Claude downloads create a normal private session, so host transcripts/result files can retain copies of transferred data.

The helper stops the child after the matching result, and a one-turn limit prevents a follow-up model request containing the payload.
The hook is scoped to the dedicated child session. Claude owns the token store, login and refresh.

Claude also needs its own model login available to the child process; the parent session alone does not guarantee that.
A token supplied only to the parent can be absent from its Bash subprocess, even when the BoxLite MCP connection succeeds.
Use an already configured host login or the user-approved shell environment; never extract tokens or change authentication in the helper.

If the selected host cannot load the authorized connection or expose these control interfaces, report the limitation and stop.
OAuth and API-key configuration remain host responsibilities; an API-key test does not establish OAuth acceptance.
Tested control interfaces are Codex 0.170.0 and Claude Code 2.1.328; revalidate after host upgrades.

Success is exit code zero with `status: completed`; this reports the MCP operation and local extraction, not an independent content-integrity check.
Upload requires the existing server's `HTTP 204` acknowledgment; an empty or unexpected tool result leaves completion unknown.
It makes one file-tool call and does not download files again or compute a checksum.

The helper never retries, changes credentials or leaves a transfer-ticket cache; after a failure, inspect possible destination effects before a new attempt.

The helper archive limit is 8 MiB including tar headers and padding; client response-size limits can be lower.
Use reviewed regular files/directories; source links, sensitive/cache paths and unsafe archive members are refused.
Upload paths must fit USTAR, including its 100-byte filename field and 155-byte directory-prefix field.

Downloads require a new local directory with existing, non-symlink parents and a filesystem that supports atomic directory placement.
The helper writes with private permissions and places the directory at the requested path only after the full archive has been written.

A guest source ending in `/.` downloads directory contents; another spelling retains the directory name.
Upload keeps the existing server overwrite behavior; choose the destination deliberately.
Guest mount paths such as `/tmp` may not support file transfer; prefer a suitable rootfs path such as `/workspace`.

## Deploy and update

Prepare the app and identify its build/start commands, port, health path, and persistent paths.
Upload reviewed source into a new release directory under `/workspace`, then build with bounded executions.
Keep configuration and data outside release directories and never upload cloud credentials.

Verify build success before replacing the app; retain the previous release and exact process identity for rollback.
Start with explicit argv, record the execution ID, and verify guest health and a real feature.
Updates reuse the same Box and data; restore the previous known app when safe after a failed replacement, and still report failure.

Public access is separate: discover the tunnel operation and schema before calling it for the app port.
OAuth forbids tunnel creation and network configuration; report the denial and block a new-public-URL claim without switching credentials.
API-key mode may register a tunnel only if its existing permissions allow it; use the returned URL, never an invented hostname.

Verify public health and a feature externally; guest health or tunnel registration alone is insufficient.
Keep database/admin/debug ports private and explain running-resource costs and idle-stop behavior.
Verify authorization and reachability even for an existing URL.

## Diagnose and clean up

Inspect Box state, recorded execution status, bounded logs, listening address, and the exact failed result.
Do not interpret a permission denial as expired login or switch MCP connections automatically.
Stop and remove only authorized explicit IDs; verify absence and report anything left behind.
