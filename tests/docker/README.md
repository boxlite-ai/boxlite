# Docker acceptance

These tests run real Docker daemons inside BoxLite guests on Linux x86_64 and
Apple Silicon macOS. Each worker owns one native SDK runtime.

## Build and run

Prepare the [DinD firmware and SDK](../../docs/guides/docker-in-docker.md)
on each host. The coordinator needs Python 3.10+. Linux SSH workers need KVM
access and a delegated user scope (`systemd-run --user --scope`).

```sh
make test:docker:dind DOCKER_ACCEPTANCE_ARGS='--runner-a user@host-a --root /path/to/boxlite --output /path/to/evidence'
```

Set `DOCKER_PYTHON` to the coordinator Python when it is outside `.venv`.
`--python` selects the worker Python; its default is `ROOT/.venv/bin/python`
for SSH and the coordinator Python for `local`.
`--runtime-dir` selects the worker native runtime through `BOXLITE_RUNTIME_DIR`.
`--known-hosts` selects the coordinator's SSH known-hosts file.
`--state-root` selects runtime storage. `--download-proxy` optionally
provides guest package/registry access; service containers receive no proxy.

For Apple Silicon, run the worker directly on the Mac with `--runner-a local`.
Point `--root` at the checkout containing the worker scripts and keep runtime
state and evidence on the selected output volume:

```sh
make test:docker:dind DOCKER_PYTHON=/path/to/sdk-python DOCKER_ACCEPTANCE_ARGS='--runner-a local --root /path/to/boxlite --state-root "/path/to/output volume/state" --output "/path/to/output volume/evidence"'
```

D1 requires `docker info`, a pulled image, a Dockerfile build with a unique
marker and execution with `--pull=never`. D2 requires a two-service Compose
application and HTTP 200 with that marker through the backend service name.

## Swarm topologies

Two Boxes in one worker exercise the same-runner topology; separate workers on
different physical hosts exercise the cross-runner topology. Use the same
checkout path and built SDK on both hosts for cross-runner tests.

Run `make test:docker:swarm` with the same arguments and one of
`--topology single`, `--topology same-runner`, or `--topology cross-runner`.
The cross-runner case also requires `--runner-b user@host-b` and
`--peer-address host-a-address`. Each topology produces its own evidence.

The [Swarm guide](../../docs/guides/docker-swarm.md) describes the guest IP
link, port exposure and network assertions. Single-node checks cover D3–D10;
both two-node topologies independently cover M1–M6, including constrained
cross-node VIP/DNSRR requests and ingress through a node without a backend task.
Apple Silicon acceptance covers `--topology single` with `--runner-a local`;
the two-node topologies are validated on Linux x86_64.

## Evidence and cleanup

Each run creates a unique output directory containing `result.json`,
`guest.log` and worker logs (`*-worker.log` locally, `*-ssh.log` over SSH).
The result records host/runtime/Box identities, including host OS and architecture,
and individual assertions. macOS uses `IOPlatformUUID` as its machine identity
and records `host_netns: null`; Linux records its machine ID and network namespace.
Guest logs include commands, exit codes and output;
the runtime also keeps `commands.log` and `acceptance-boxes.json`.

Successful runs remove their Boxes and close forwarders. Failures retain Box
disks and daemon diagnostics under the selected state root. Inspect or remove
those Boxes with the same BoxLite runtime home before deleting that directory.
Logs include local infrastructure details and belong in private evidence storage.
