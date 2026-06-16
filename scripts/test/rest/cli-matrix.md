# REST CLI Command Matrix

This matrix runner proves the user-facing CLI still works when the runtime is
REST-backed. It is intentionally separate from local CLI integration tests:
those exercise command parsing and local runtime behavior, while this runner
targets a deployed or local REST API.

## Run

```bash
make test:rest:cli AUTH=api-key SCOPE=smoke
make test:rest:cli AUTH=oidc SCOPE=full
```

Equivalent direct call:

```bash
scripts/test/rest/run_cli_matrix.sh api-key smoke
scripts/test/rest/run_cli_matrix.sh oidc full
```

## Required Inputs

| Input | API key | OIDC | Notes |
| --- | --- | --- | --- |
| `BOXLITE_CLI` | optional | optional | CLI binary to test; defaults to `boxlite` on `PATH`. |
| `BOXLITE_REST_URL` | required | optional | API base URL. For OIDC, the stored profile may already carry the URL. |
| `BOXLITE_API_KEY` | required | must be unset | API-key auth uses this env var. OIDC must avoid it because it takes precedence. |
| `BOXLITE_PROFILE` | optional | recommended | Named profile to use. |
| `BOXLITE_HOME` | optional | optional | Isolated credentials/home directory. |
| `BOXLITE_REST_SMOKE_IMAGE` | optional | optional | Defaults to `alpine:3.23`. |

For `AUTH=oidc`, `auth whoami` must print `Logged in as:` and `Server:`.
This prevents the matrix from silently falling back to local runtime behavior
when the profile is missing or expired.

## Coverage

| Group | Smoke | Full | REST coverage | Notes |
| --- | --- | --- | --- | --- |
| Auth | `auth status`, `auth whoami` | same | `/v1/me`, credential source | OIDC requires an existing logged-in profile. |
| Discovery | `ls --format json` | `list`, `ls`, `ps` | list boxes | `ps` is an alias filtered to active boxes. |
| Create/lifecycle | `create`, `start`, `stop`, `rm` | plus `restart`, `inspect` | create/get/start/stop/remove | Cleanup is attempted in a trap. |
| Execution | `exec BOX -- sh -lc ...` | same plus `run --rm` | HTTP exec plus WebSocket attach | This is the OIDC attach regression path. |
| Files | no | `cp` host-to-box and box-to-host | REST file upload/download | Uses temporary files. |
| Metrics | no | `stats --format json` | REST metrics proxy | Runs while the box is started. |
| Images | skipped | skipped | none | REST runtime currently does not support `pull`/`images`. |
| Logs | skipped | skipped | none | CLI `logs` currently reads local runtime console logs, not REST. |
| Info | skipped | skipped | none | CLI `info` currently reports local runtime/options, not REST. |
| Remove alias | skipped | skipped | none | `boxlite remove` does not exist; use `rm`. |

## Artifacts

Each run writes:

- `target/rest-test-report/cli-matrix-<auth>-<scope>.log`
- `target/rest-test-report/cli-matrix-<auth>-<scope>.skips`
- `target/rest-test-report/cli-matrix-<auth>-<scope>.md`

Skip entries are explicit and are not treated as failures unless a command is
listed as covered by the selected scope.
