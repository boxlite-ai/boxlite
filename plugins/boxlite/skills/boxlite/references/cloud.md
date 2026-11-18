# Shared cloud operations

Both cloud authentication modes use `https://api.boxlite.ai/mcp`, the same discovered tools, and this workflow.
Only the credential and its granted permissions differ; never use BoxLite CLI or shell HTTP for these operations.

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

`uploadFiles` takes a base64 tar archive, destination, and overwrite choice; `downloadFiles` returns an archive.
Exclude credentials, `.env*`, `.git`, private plugin state, caches, and persistent data unless explicitly requested.
Reject unreviewed symlinks and special files in deployment sources.

Stay within discovered limits, currently 8 MiB of archive bytes; do not echo large base64 payloads to the user.
Upload into a fresh, uniquely named release directory rather than relying on `overwrite: false` to protect existing data.

That flag's refusal and preservation behavior is a release acceptance gate; do not promise protection until verified on the deployed service.
Small text files can use bounded execution with explicit argv; `read_file`, `write_file`, and `list_dir` are not BoxLite MCP tools.

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
