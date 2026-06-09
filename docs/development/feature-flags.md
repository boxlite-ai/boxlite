# Feature Flags and Deploy-Time Environment Variables

This file documents environment variables that gate features or configure
runtime behavior in the hosted BoxLite API service. These variables are
read at process start; changing them requires a service restart.

## Security Options

### `SECURITY_OPTIONS_ENABLED`

| Attribute | Value |
|---|---|
| Service | `apps/api` |
| Type | Boolean (`"true"` / anything else) |
| Default (absent) | `false` — security options are disabled |
| Default (empty string) | `false` |
| Malformed value | Treated as `false` (any value other than the exact string `"true"`) |

**What it gates:**

- Allows callers to submit `security` in `CreateSandbox` requests.
  When `false`, any request that includes a `security` field is rejected
  with `400 Bad Request`.
- Disables warm-pool sandbox reuse for sandboxes that do not carry
  effective security options (warm-pool sandboxes are created without a
  security policy and cannot be safely reused when the feature is active).
- At warm-pool replenishment time, filters the runner pool to
  `supportsSecurityOptions=true` runners only.

**Rollback:** Set to `false` (or remove). Existing sandboxes that already
have stored `effectiveSecurityOptions` will continue to be routed to
capable runners by the lifecycle paths, which use the stored policy rather
than this flag.

---

### `RUNNER_SUPPORTS_SECURITY_OPTIONS`

| Attribute | Value |
|---|---|
| Service | `apps/api` |
| Type | Boolean (`"true"` / anything else) |
| Default (absent) | `false` |
| Default (empty string) | `false` |
| Malformed value | Treated as `false` |

**What it gates:**

- Controls the `supportsSecurityOptions` flag of the **default (in-process)
  runner** that `AppService` registers at startup. This runner is used in
  single-binary / local deployments where there is no external runner.
- When `SECURITY_OPTIONS_ENABLED=true`, set this to `true` so that the
  default runner is eligible to receive security-options payloads.
- Has no effect when the deployment uses only externally-registered runners
  (each registered runner carries its own `supportsSecurityOptions` flag set
  at registration time via the admin or runner API).

**Absent-value behavior:** Default runner is created with
`supportsSecurityOptions=false`, which means it will not be selected for
sandboxes that require security capability. Jobs requiring security will
return `400` (no capable runners) unless another capable runner is
registered.

---

## Usage in Local Development

```bash
# Enable security options + mark the default runner capable
SECURITY_OPTIONS_ENABLED=true
RUNNER_SUPPORTS_SECURITY_OPTIONS=true
```

Add these to your local `.env` or shell profile when testing the security
options end-to-end path locally.

## Usage in CI / Staging

Set both variables in the service environment. For the runner, ensure the
runner binary is registered with `supportsSecurityOptions: true` via the
admin API or via `RUNNER_SUPPORTS_SECURITY_OPTIONS=true` for the default
in-process runner.

## Relationship to `Runner.supportsSecurityOptions`

The `Runner` entity has a boolean `supportsSecurityOptions` column
(DB default: `false`). Each runner binary must be explicitly opted in:

- **In-process default runner:** controlled by `RUNNER_SUPPORTS_SECURITY_OPTIONS`.
- **Externally-registered runners:** set `supportsSecurityOptions: true` when
  calling `POST /runner` (admin API) or `POST /api/runner` (runner API).

A sandbox with stored `effectiveSecurityOptions` will only be dispatched to
runners where `supportsSecurityOptions=true`, regardless of the
`SECURITY_OPTIONS_ENABLED` flag.
