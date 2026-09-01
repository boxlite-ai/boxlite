# CLI secrets MITM flag (issue #1238)

**Date:** 2026-08-31
**Status:** Implemented (verified end-to-end, see §4 verification log)
**Tracks:** https://github.com/boxlite-ai/boxlite/issues/1238

---

## Problem

`boxlite run` / `boxlite create` have no CLI way to configure secret
substitution ("secrets MITM"). The runtime pipeline is complete: a secret
configured on `BoxOptions.secrets` reaches the in-shim gvproxy MITM proxy in
both local and REST modes. Only the argv → `BoxOptions.secrets` segment is
missing.

Issue text: "Add a flag to do secret substitute in the boxlite cli".

## Current pipeline (verified, no changes needed)

```
CLI --secret (missing — the only gap)
   ▼
BoxOptions.secrets                        runtime/options.rs:442
   ├── local mode: LocalRuntime::create   runtime/rt_impl.rs:1790
   │    └── build_network_backend         litebox/init/tasks/vmm_spawn.rs:347-363
   │         (secrets: options.secrets.clone() → NetworkBackendConfig)
   └── REST mode: RestRuntime::create     rest/runtime.rs:199
        └── CreateBoxRequest::from_options  rest/types.rs:157-160 (secrets mapped)
        └── POST /boxes → serve build_box_options  cli/src/commands/serve/mod.rs:819-846
             (parses + defaults placeholder; rejects empty name/value :804-812)
   ▼
NetworkBackendSpec.secrets (+ CA PEM)     net/mod.rs:79-94 (minted by spec(), gvproxy/services.rs:346-359)
   ▼
InstanceSpec.network_backend_spec         vmm/mod.rs:254 (assembled vmm_spawn.rs:234)
   ▼
config_json → stdin → boxlite-shim       shim/src/main.rs:84
   ▼
GvproxyInstance → GvproxyConfig → Go MITM  (shim built with features=["gvproxy","krun"], src/shim/Cargo.toml:15)
```

Notes:

- `sanitize_remote` does NOT reject secrets (rest/runtime.rs:103-138).
- `sanitize_local_options` does NOT validate secrets (runtime/rt_impl.rs:1769).
- The CLI crate depends on `boxlite = { features = ["rest"] }`
  (src/cli/Cargo.toml:18) — sufficient; the Go engine lives in the shim binary.

## Design

### Flags

```rust
#[derive(Args, Debug, Clone)]
pub struct SecretFlags {
    /// Secret for MITM substitution: NAME=VALUE (repeatable).
    /// Hosts default to none; pair with --secret-host.
    #[arg(long = "secret", value_name = "NAME=VALUE")]
    pub secrets: Vec<String>,

    /// Read a secret's value from an environment variable (repeatable):
    /// NAME=ENV_VAR. The value never appears on argv, in shell history,
    /// or in CI command logs.
    #[arg(long = "secret-from-env", value_name = "NAME=ENV_VAR")]
    pub secret_env: Vec<String>,

    /// Host where a secret applies: NAME=HOST (repeatable; "*.example.com"
    /// wildcards match one subdomain level).
    #[arg(long = "secret-host", value_name = "NAME=HOST")]
    pub hosts: Vec<String>,
}
```

### `apply_to` semantics (on `BoxOptions`)

For each `--secret NAME=VALUE` and `--secret-from-env NAME=ENV_VAR`:

1. **Parse** `NAME=VALUE` (split_once `=`; missing `=` or empty NAME/VALUE →
   error, matching serve's validation at serve/mod.rs:804-812).
2. **Env source**: read `ENV_VAR` from `std::env::var`; missing → error naming
   the variable (fail fast, no silent empty value).
3. **Default the placeholder** to `<BOXLITE_SECRET:{name}>` when the flag
   syntax cannot express one. This is load-bearing: the local runtime does NOT
   synthesize a default placeholder (serve/mod.rs:814-818 — "the local runtime
   does not synthesize... for an empty placeholder"), so a placeholder-less
   secret would inject an empty env var and no MITM substitution (POL-303
   failure class). Defaulting in the CLI makes local and REST modes behave
   identically.
4. **Attach hosts**: each `--secret-host NAME=HOST` pairs with the secret of
   the same NAME (match serve's `SecretSpecRequest` shape: name/value/hosts/
   placeholder). Secrets with no matching host rule get empty `hosts` —
   gvproxy's `SecretHostMatcher` then never matches them, so they are inert;
   the CLI should warn or error on a secret that has no host rule. Decision:
   **error** (a secret with no host is always a mistake).
5. Push `Secret { name, value, hosts, placeholder }` onto `opts.secrets`.

### Wiring

- `RunArgs`: `#[command(flatten)] secret: SecretFlags`; `create_box()` calls
  `self.args.secret.apply_to(&mut options)?` (run.rs:88-117).
- `CreateArgs`: same flatten; `to_box_options()` calls apply (create.rs:69-107).
- No changes to boxlite library, shim, gvproxy, serve, CA, or runtime.

### Key decisions

| Decision                      | Choice                                                                             | Rationale                                                                                                                                                                                                              |
|-------------------------------|------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Env over stdin                | `--secret-from-env`, not `--secret-stdin`                                          | `run`'s stdin belongs to the guest (`--interactive`/`--tty`); reading secrets from it needs a fragile split protocol and breaks terminal echo semantics. Env vars don't enter argv, shell history, or CI command logs. |
| argv exposure                 | `--secret NAME=VALUE` kept for interactive use; `--secret-from-env` for scripts/CI | Repo precedent: `auth login --api-key-stdin` — "the secret never appears on argv" (src/cli/src/commands/auth/login.rs:35-38).                                                                                          |
| Placeholder defaulting in CLI | Yes, `<BOXLITE_SECRET:{name}>`                                                     | Local mode has no serve-side default; without it, silent empty-env failure (POL-303 class).                                                                                                                            |
| Host-less secret              | Error                                                                              | Always a mistake; matches serve's strictness.                                                                                                                                                                          |
| Repeatable flags              | `Vec<String>` per flag                                                             | Matches `--allow-net`/`--env` conventions.                                                                                                                                                                             |

## Test plan

### 1. Unit — CLI parsing (src/cli/src/commands/run.rs / create.rs tests)

Follow the existing `run_capability_flags_are_repeatable` /
`create_capability_flags_reach_box_options` pattern (cli::try_parse_from):

| Case             | Input                                                           | Assert                                                                                               |
|------------------|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| direct value     | `--secret openai=sk-123`                                        | `opts.secrets[0] = {name:"openai", value:"sk-123", hosts:[], placeholder:"<BOXLITE_SECRET:openai>"}` |
| repeatable       | `--secret a=1 --secret b=2`                                     | two secrets, order preserved                                                                         |
| env source       | `--secret-from-env openai=OPENAI_KEY` (env `OPENAI_KEY=sk-env`) | value `sk-env`, placeholder defaulted                                                                |
| env missing      | `--secret-from-env openai=NOPE` (unset)                         | error naming `NOPE`                                                                                  |
| malformed        | `--secret openai` / `--secret =v` / `--secret n=`               | error                                                                                                |
| host pairing     | `--secret openai=sk --secret-host openai=api.openai.com`        | hosts `["api.openai.com"]`; repeated `--secret-host` accumulates                                     |
| host-less secret | `--secret openai=sk` with no `--secret-host`                    | error                                                                                                |
| no flags         | no secret flags                                                 | `opts.secrets` untouched (empty)                                                                     |
| empty-name host  | `--secret-host =h`                                              | error                                                                                                |

### 2. Unit — `apply_to` (same modules)

- Placeholder default is `<BOXLITE_SECRET:{name}>` for names needing
  sanitization (`my-key` → env key `BOXLITE_SECRET_MY_KEY` per
  `Secret::env_key`, runtime/options.rs:471-488).
- Env read is pure: factor the env lookup behind a parameter so tests do not
  touch process env (or use serial tests with `temp_env`-style guard — check
  repo convention first).

### 3. Integration — wire (already covered, no new tests)

- `build_box_options_carries_secrets_from_the_wire` (serve/mod.rs:1429)
  covers REST parsing; CLI→`BoxOptions`→`CreateBoxRequest::from_options`
  serialization is covered by `test_create_box_request_serialization`
  (rest/types.rs:704).

### 4. End-to-end (manual, both modes)

Prerequisites: `make runtime:debug` (host mke2fs/debugfs), `make guest`
(guest artifacts incl. guest-mke2fs/resize2fs), gvproxy feature built.

**Local mode** (no `--url`):

```bash
boxlite run --rm \
  --secret openai=sk-test-123 \
  --secret-from-env anthropic=ANTHROPIC_KEY \
  --secret-host openai=api.openai.com \
  --secret-host anthropic=api.anthropic.com \
  alpine sh -c 'echo $BOXLITE_SECRET_OPENAI; echo $BOXLITE_SECRET_ANTHROPIC'
```

**MITM replacement (the actual substitution):** the placeholder-inject
check alone does NOT prove gvproxy swapped the value — it only proves the
env reached the guest. To observe the substitution at the upstream side, use
a public request-echo service that echoes request headers (real certificate,
so gvproxy's upstream TLS verification against the system CA pool passes;
the guest trusts gvproxy's ephemeral CA via the `CACert` proto field —
vmm_spawn.rs:110-114):

```bash
boxlite run --rm \
  --secret openai=sk-test-123 \
  --secret-host openai=httpbin.org \
  alpine sh -c 'wget -qO- --header="Authorization: $BOXLITE_SECRET_OPENAI" https://httpbin.org/headers'
```

Expected: the echoed `Authorization` header shows the REAL value
(`sk-test-123`), proving guest→(placeholder)→gvproxy→(substitution)→upstream.
Alternatives to httpbin.org: postman-echo.com/headers (same shape).

**REST mode** (`--url` to a local `boxlite serve`):

Start the server first — `boxlite serve` binds `0.0.0.0:8100` by default
(`LOCAL_SERVE_HOST`/`LOCAL_SERVE_PORT`, defaults.rs:7,10; `--host`/`--port`
override) and holds an embedded `LocalRuntime` in `AppState`
(serve/mod.rs:1302-1321): the process is an axum HTTP front-end over the same
runtime the local mode uses, so the downstream path (env inject → CA → shim →
gvproxy) is identical. No API key by default; `--api-key` enables the
`require_api_key` middleware.

```bash
boxlite serve &
# 1. Placeholder inject (wire round-trip + serve parsing)
boxlite --url http://127.0.0.1:8100 run \
  --secret openai=sk-test-123 --secret-host openai=api.openai.com \
  alpine sh -c 'echo $BOXLITE_SECRET_OPENAI'

# 2. Full MITM replacement (same httpbin.org echo as local mode)
boxlite --url http://127.0.0.1:8100 run --rm \
  --secret openai=sk-rest-123 --secret-host openai=httpbin.org \
  alpine sh -c 'wget -qO- --header="Authorization: $BOXLITE_SECRET_OPENAI" https://httpbin.org/headers'
```

Verify:
- Check 1: guest prints `<BOXLITE_SECRET:openai>` — the secrets survived
  `CreateBoxRequest::from_options` (rest/types.rs:157-160) → POST /boxes →
  `build_box_options` (serve/mod.rs:819-846) and reached the runtime.
- Check 2: httpbin echoes `"Authorization": "sk-rest-123"` — substitution
  happens on the REST path too, proving serve parsed the secrets and handed
  the real values to its embedded runtime.

### 5. Security check

- `ps aux | grep boxlite` while a `--secret-from-env` run is active: value
  must NOT appear; with `--secret NAME=VALUE` it will — documented in
  `docs/reference/cli/README.md`.
- `BOX` secret value must never appear in `config_json` logs (the shim's
  TRACE event strips secrets — controller/shim.rs:221-227) or in
  `InstanceSpec` Debug output.

### 6. Docs

- `docs/reference/cli/README.md`: add `--secret`, `--secret-from-env`,
  `--secret-host` rows; note the argv exposure caveat and the env alternative.

## Verification log (2026-08-31, executed)

All checks ran against `target/debug/boxlite` (embedded runtime, debug build)
with `alpine:latest`.

| # | Check                           | Command (abridged)                                                                                                                                                                                                             | Result                                                                                    |
|---|---------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| 1 | Unit tests                      | `cargo test -p boxlite-cli --bin boxlite`                                                                                                                                                                                      | 206/206 pass (11 new: 9 flag unit + run/create wiring)                                    |
| 2 | Lint/format                     | `cargo clippy -p boxlite-cli --bin boxlite`, `cargo fmt -p boxlite-cli`                                                                                                                                                        | clean                                                                                     |
| 3 | Help surface                    | `boxlite run --help`                                                                                                                                                                                                           | `--secret`, `--secret-from-env`, `--secret-host` listed                                   |
| 4 | Local mode: placeholder inject  | `boxlite run --secret openai=sk-test-123 --secret-host openai=api.openai.com alpine sh -c 'echo $BOXLITE_SECRET_OPENAI'`                                                                                                       | guest prints `<BOXLITE_SECRET:openai>`; real value never enters VM                        |
| 5 | CA mint                         | same + `-d`, then `find ~/.boxlite/boxes/<id>/ca/`                                                                                                                                                                             | `cert.pem` 0644, `key.pem` 0600                                                           |
| 6 | **MITM replacement**            | `boxlite run --secret openai=sk-test-123 --secret-host openai=httpbin.org alpine sh -c 'wget -qO- --header="Authorization: $BOXLITE_SECRET_OPENAI" https://httpbin.org/headers'`                                               | httpbin echoes `"Authorization": "sk-test-123"` — placeholder substituted at the boundary |
| 7 | REST mode: placeholder inject   | `boxlite serve` + `boxlite --url http://localhost:8100 run --secret openai=sk-rest-456 --secret-host openai=api.openai.com alpine sh -c 'echo $BOXLITE_SECRET_OPENAI'`                                                         | guest prints `<BOXLITE_SECRET:openai>` (placeholder), value absent                        |
| 8 | **REST mode: MITM replacement** | `boxlite serve` + `boxlite --url http://localhost:8100 run --secret openai=sk-rest-123 --secret-host openai=httpbin.org alpine sh -c 'wget -qO- --header="Authorization: $BOXLITE_SECRET_OPENAI" https://httpbin.org/headers'` | httpbin echoes `"Authorization": "sk-rest-123"` — substituted on the REST path            |

Checks 6 and 8 close the loop the placeholder-inject checks (4, 7) leave
open: each observes the substituted value at the upstream side (httpbin echo),
proving gvproxy — not the guest — performed the replacement, on the local
path (6) and the REST path (8) alike. Both also prove the guest trusts the
ephemeral MITM CA (TLS handshake succeeds) and that gvproxy's upstream TLS
verification passes against a real certificate (httpbin.org's LE cert vs the
system CA pool). Body substitution (the `streamingReplacer` path) is covered
by Go-side unit tests (`gvproxy-bridge/mitm_replacer_test.go`), not by this
log.

## Implementation checklist

- [x] `SecretFlags` in src/cli/src/cli.rs (parse + validate + default + pair hosts)
- [x] flatten into `RunArgs` / `CreateArgs`; `apply_to` in both command paths
- [x] unit tests per table above (parse, defaulting, validation, pairing)
- [x] `docs/reference/cli/README.md` flag rows
- [x] e2e verify local mode (env placeholder + CA + MITM replacement)
- [x] e2e verify REST mode (`--url` to serve)
- [ ] commit through the agent-tooling gates (lint-fix + commit-push-auditor)

## Open items

- `--secret-stdin` (detach-only) as a follow-up; explicitly rejected for
  interactive mode.
- Whether placeholder should be expressible per-secret (e.g. `NAME=VALUE@PLACEHOLDER`)
  — currently not; serve-side defaulting and env-key sanitization cover the
  documented cases.
