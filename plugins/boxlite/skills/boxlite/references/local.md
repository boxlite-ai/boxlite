# Independent local runtime

Local uses the embedded runtime on the execution host, without a cloud account or cloud MCP call.
It needs shell execution, Python 3.9+, and a compatible BoxLite CLI with native runtime resources.
Linux requires usable `/dev/kvm`; macOS requires Apple Silicon and Hypervisor.framework.

## Prepare

Check CLI version, architecture, and virtualization access before creating workloads.
Follow the official [installation and verification guide](https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/cli/README.md#installation--verification) if needed.
Verify checksums and provenance before execution; a stub build cannot run real Boxes.

Create private `.boxlite/plugin.json` outside Git with the actual absolute paths:

```json
{"mode":"local","cli":"/absolute/path/to/boxlite","home":"/absolute/path/to/dedicated-local-runtime"}
```

Restrict private-state permissions and exclude it from application archives.
The runtime home must have no `credentials.toml`; choose another home instead of deleting existing credentials.
Keep this home stable to preserve Box identity and data.

## Operate

Resolve `SKILL_DIR` to the installed skill and `SESSION` to the private configuration.
Use the launcher for every local workload command: it clears cloud overrides and pins the home and default profile.
Routing flags are forbidden before the guest `--` delimiter.

```sh
python3 SKILL_DIR/scripts/local.py SESSION -- list --format json
python3 SKILL_DIR/scripts/local.py SESSION -- create alpine:3.22 --name hello-local
python3 SKILL_DIR/scripts/local.py SESSION -- start RETURNED_ID
python3 SKILL_DIR/scripts/local.py SESSION -- exec RETURNED_ID -- /bin/echo hello
```

Read installed CLI help before using additional flags or port mappings.
Use returned IDs, verify output and exit status, and inspect uncertain execution before retrying.
Transfer reviewed files with the launcher's `cp` and verify a round trip.

For a local HTTP service, publish a host port, for example `create -p 18080:8000 IMAGE`.
This binds `0.0.0.0:18080` on the host, so LAN clients can reach it when the host firewall allows access.

The CLI's `-p` syntax currently accepts port numbers, not a host bind address; do not describe this as loopback-only access.
If loopback-only access is required, stop before publishing until an appropriate host firewall restriction is in place.
Inbound policy does not gate local port mappings in the embedded runtime.

Bind the guest server to its guest interface and verify the actual localhost endpoint without claiming cloud HTTPS or creating a tunnel.
Update in the same local Box and preserve persistent paths.

## Clean up

```sh
python3 SKILL_DIR/scripts/local.py SESSION -- stop RETURNED_ID
python3 SKILL_DIR/scripts/local.py SESSION -- rm RETURNED_ID
python3 SKILL_DIR/scripts/local.py SESSION -- list --format json
```

Delete only authorized explicit IDs and verify absence.
Plugin uninstall must not remove runtime homes, other Boxes, volumes, or cloud resources.
Missing virtualization or runtime libraries blocks Local; never switch to cloud automatically.
