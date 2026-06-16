# REST Test Utilities

Utilities in this directory support the reusable REST API test workflow.

## Inventory

Run:

```bash
make test:rest:inventory
```

This parses `openapi/box.openapi.yaml`, scans candidate REST/E2E/CLI test files,
and writes:

- `target/rest-test-report/rest-inventory.md`
- `target/rest-test-report/rest-inventory.json`

The report is intentionally conservative. `candidate` means matching test text
exists; it does not claim the operation is fully asserted.

## CLI matrix

Run against a deployed or local REST API:

```bash
make test:rest:cli AUTH=api-key SCOPE=smoke
make test:rest:cli AUTH=oidc SCOPE=full
```

See `scripts/test/rest/cli-matrix.md` for the command matrix, required
environment, skip policy, and artifacts.

## E2E auth matrix

Run the existing REST SDK -> API -> Runner -> VM suite with an explicit auth
mode:

```bash
make test:rest:e2e AUTH=api-key
make test:rest:e2e AUTH=oidc
```

`AUTH=oidc` uses `BOXLITE_E2E_OIDC_TOKEN` or a stored OIDC profile
`access_token`. Stored OIDC profiles are refreshed through `boxlite auth
whoami` before the Python SDK runtime is built. Both modes discover
`path_prefix` from `/v1/me` unless `BOXLITE_E2E_PREFIX` is set.

## Aggregate report

```bash
make test:rest:report
```

This writes `target/rest-test-report/rest-report.md` from the inventory and
CLI matrix artifacts that already exist.
