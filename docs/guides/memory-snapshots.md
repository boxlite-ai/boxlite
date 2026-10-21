## TL;DR

Memory snapshots have an explicit SDK and REST contract, tested with mocks.
Production rejects memory capture and restore; no RAM or machine state is saved.

## Details

Python selects the type explicitly:

```python
snapshot = await box.snapshot.create(
    name="checkpoint", options=boxlite.SnapshotOptions(snapshot_type="memory")
)
snapshot = await box.snapshot.get("checkpoint")
child = await box.snapshot.create_box("checkpoint", name="child")
```

These calls succeed only against the test fixture in
`sdks/python/tests/test_memory_snapshot_contract.py`. The fixture assembles an
API mock and runner mock on ephemeral loopback ports. It creates no VM, disk,
RAM image or executable child. There is no production environment variable,
request flag or configuration option that enables this simulation.

Rust uses `SnapshotType::Memory`; Node uses `{ snapshotType: "memory" }` and
`box.snapshot.createBox(name, childName)`. Omitting the type keeps the existing
filesystem default. Unknown types are invalid; memory never falls back to FS.
Metadata adds `snapshot_type` and `is_mock`; older FS metadata defaults to
`filesystem` and false. Mock snapshots are immediately available in the fixture
and disappear when that fixture stops. Production metadata never contains mock
records. No durable storage or scheduling claim follows from the mock.

The REST calls are `POST /boxes/{id}/snapshots`, `GET` on that collection or a
named snapshot, and `POST /boxes/{id}/snapshots/{name}/boxes` with `{"name": ...}`.
Production create-from is reserved and returns Unsupported. The API checks Box
organization ownership and mutation permission, routes to its owning runner,
and does not auto-start the source. The runner returns 501 with
`error.code="unsupported"`; local SDK errors are `UnsupportedError`.

`GET /config` advertises `memory_snapshots_enabled: false`, including the test
server: a simulated result never proves real memory support. A memory create
response must retain the requested type and explicitly set `is_mock: true`.
The SDK rejects filesystem substitution and unmarked memory success.

After `make dev:python SETUP_DONE=1`, run `make test:snapshot-contract` for S6.
Additional production-boundary checks are `make test:apps:api FILTER=memory`
and `make test:apps:runner FILTER=MemorySnapshot`. S6 may be recorded as
**MOCK_PASS** only. This feature does not implement FS create-from, source
deletion survival, snapshot placement or live memory recovery.
