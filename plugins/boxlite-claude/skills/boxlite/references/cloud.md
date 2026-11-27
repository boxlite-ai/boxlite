# Shared cloud operations

Both cloud authentication modes use the BoxLite MCP service and the tools discovered on the selected connection.
The selected credential determines the granted permissions. Lifecycle and execution use native MCP; the packaged file helper calls the existing MCP file tools programmatically.

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

Use Python 3.9+ on the host and the exact configured MCP connection name and Box ID.
Supply absolute paths on both ends. Keep archive bytes inside the transfer tools.

### Claude Code

Use the BoxLite tools from the current session. Replace `SELECTED_CONNECTION` with the complete MCP connection name verified during setup for the user's chosen mode.

| Tool | Arguments |
| --- | --- |
| `mcp__boxlite__upload` | `{"connection":"SELECTED_CONNECTION","box_id":"BOX_ID","local_source":"/home/user/report.csv","remote_destination":"/workspace/report.csv"}` |
| `mcp__boxlite__download` | `{"connection":"SELECTED_CONNECTION","box_id":"BOX_ID","remote_source":"/workspace/report.csv","local_destination":"/home/user/new-download"}` |

Claude applies its current permission mode and rules to the requested operation, connection, Box and paths.
Configure tool rules on these two transfer tools. An authorized directory transfer covers its contents.

After authorization, the plugin runs Python for local archive I/O and calls the selected connection's `uploadFiles` or `downloadFiles` directly.
Claude receives a short receipt. Claude Code can retain large downloads in its private session storage.

The worker accepts a saved result only when it can identify a single matching download on this connection in the current session during the call. If the transfer tools or selected connection are unavailable, report that to the user.

### Codex

Use the packaged helper with the selected server in the Codex app-server configuration.
Resolve `SKILL_DIR` to this installed skill.

```sh
python3 SKILL_DIR/scripts/transfer.py --host codex --server SELECTED_SERVER upload --box BOX_ID --source /absolute/reviewed-source --destination /workspace/new-release
python3 SKILL_DIR/scripts/transfer.py --host codex --server SELECTED_SERVER download --box BOX_ID --source /workspace/new-release/. --destination /absolute/new-download
```

### Transfer results

A successful transfer returns a receipt with `status: completed`. The Codex command also exits with code zero.

Upload requires the existing server's `HTTP 204` acknowledgment; an empty or unexpected tool result leaves completion unknown.
It makes one file-tool call and does not download files again or compute a checksum.

For HTTP 403, check the selected connection's permissions. BoxLite Cloud requires `write:boxes` for both uploads and downloads.

Invalid arguments, missing resources and Box state conflicts have specific messages. If a download exceeds the MCP response limit of 8 MiB, select fewer or smaller files.

The helper never retries, changes credentials or leaves a transfer-ticket cache; after a failure, inspect possible destination effects before a new attempt.

Uploads include the selected directory’s contents, including hidden files. Symbolic links travel as links, preserving their target text.

Codex and Claude stop an upload before calling MCP if its tar archive would exceed 8 MiB, including headers and padding. This limit applies before Base64 encoding.

Downloads preserve GNU sparse files from the Box. The helper writes the stored data ranges and recreates holes without imposing a limit on the file's logical size.

Downloads require a new local directory, an existing parent and a filesystem that supports atomic directory placement.
The helper writes with private permissions and places the directory at the requested path only after the full archive has been written.

If the parent moved during placement, the helper reports that the download was written and the requested path changed.

A guest source ending in `/.` downloads directory contents. Other paths retain the directory name.

A single-file upload can name a destination file and follows the server's overwrite behavior.
Uploads and downloads preserve only the owner's read, write and execute bits (`mode & 0700`). Downloads apply these permissions after writing the regular or sparse file.

Guest mount paths such as `/tmp` may not support file transfer. Use a suitable rootfs path such as `/workspace`.

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
