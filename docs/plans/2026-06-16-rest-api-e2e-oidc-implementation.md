# REST API E2E and OIDC CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build reusable REST API coverage for BoxLite and fix the OIDC CLI/dev failures around stale path prefixes and WebSocket attach.

**Architecture:** Keep the existing REST E2E suite as the foundation. Add a thin REST test command layer, focused inventory/report scripts, and auth-matrix fixtures while fixing the two root causes in CLI credentials and API WebSocket auth. Dev validation happens last, after local/unit verification and only restarts the dev API when the API patch is ready.

**Tech Stack:** Rust CLI tests, NestJS/Jest API tests, Makefile targets, Python pytest E2E fixtures, OpenAPI YAML, optional Schemathesis-compatible contract runner.

---

## Guardrails

- Do not run dev tests first. Dev is already deployed.
- Do not restart Runner unless Runner code changes.
- Use make targets when they exist.
- Keep API-key behavior unchanged while adding OIDC.
- Every new regression test must prove a real project boundary, not a tautology.
- For dev validation, build/run on the dev machine, not the local Mac.

## Task 1: REST Inventory Report Script

**Files:**
- Create: `scripts/test/rest/inventory.mjs`
- Create: `scripts/test/rest/README.md`
- Modify: `make/test.mk`
- Output: `target/rest-test-report/rest-inventory.md`

**Step 1: Create the script skeleton**

Implement `scripts/test/rest/inventory.mjs` with the apps workspace `yaml` parser. Run it through `cd apps && yarn node ../scripts/test/rest/inventory.mjs` so it uses the existing `apps/package.json` dependency instead of adding a Python YAML dependency.

The implementation should parse the OpenAPI document structurally, collect operations from `paths`, scan candidate test files, and emit both Markdown and JSON reports under `target/rest-test-report/`.

**Step 2: Run inventory**

Run:

```bash
cd apps && yarn node ../scripts/test/rest/inventory.mjs
```

Expected:

- Creates `target/rest-test-report/rest-inventory.md`.
- Does not modify source except generated report under `target/`.

**Step 3: Add make target**

Modify `make/test.mk`:

```make
test\:rest\:inventory: _ensure-apps-deps
	@cd apps && yarn node ../scripts/test/rest/inventory.mjs
```

**Step 4: Verify**

Run:

```bash
make test:rest:inventory
```

Expected: prints `target/rest-test-report/rest-inventory.md`.

**Step 5: Commit**

```bash
git add make/test.mk scripts/test/rest
git commit -m "test: add REST API inventory report"
```

## Task 2: CLI OIDC Path Prefix Self-Heal

**Files:**
- Modify: `src/cli/src/commands/auth/whoami.rs`
- Modify: `src/cli/tests/auth.rs`

**Step 1: Write failing test**

Add a test in `src/cli/tests/auth.rs`:

```rust
#[test]
fn whoami_updates_stale_profile_path_prefix() {
    let stub = Stub::start(|_m, path| match path {
        "/v1/me" => (
            200,
            r#"{"sub":"usr_1","principal_type":"user","email":"dev@acme.test","display_name":"Dev","path_prefix":"fresh","scopes":["box:read"]}"#.to_string(),
        ),
        _ => (404, NOT_FOUND_JSON.to_string()),
    });
    let home = TempDir::new().unwrap();

    auth_cmd(&home)
        .args(["auth", "login", "--url", &stub.url(), "--api-key-stdin"])
        .write_stdin("k_test\n")
        .assert()
        .success();

    let creds = creds_path(&home);
    let stale = std::fs::read_to_string(&creds).unwrap().replace("path_prefix = \"fresh\"", "path_prefix = \"stale\"");
    std::fs::write(&creds, stale).unwrap();

    auth_cmd(&home)
        .args(["auth", "whoami"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Path prefix:     fresh"));

    let updated = std::fs::read_to_string(&creds).unwrap();
    assert!(updated.contains("path_prefix = \"fresh\""), "{updated}");
    assert!(!updated.contains("path_prefix = \"stale\""), "{updated}");
}
```

**Step 2: Run to verify failure**

Run:

```bash
make test:integration:cli FILTER=whoami_updates_stale_profile_path_prefix
```

Expected: FAIL because `whoami` prints fresh server value but does not persist it.

**Step 3: Implement self-heal**

In `whoami.rs`, return enough context from `resolve_options` to know whether the credential came from a named profile. After successful `auth.whoami()`, if the stored profile exists and `p.path_prefix != profile.path_prefix`, save the profile with the server value.

Minimal structure:

```rust
struct ResolvedOptions {
    opts: BoxliteRestOptions,
    stored_profile: Option<Profile>,
}
```

Add helper:

```rust
fn maybe_update_path_prefix(profile_name: &str, mut profile: Profile, server_prefix: Option<String>) -> Result<()> {
    if profile.path_prefix == server_prefix {
        return Ok(());
    }
    profile.path_prefix = server_prefix;
    credentials::save_named(profile_name, &profile).context("saving refreshed path prefix")
}
```

Only call this for stored profiles, never env-only API key credentials.

**Step 4: Run tests**

Run:

```bash
make test:integration:cli FILTER=whoami_updates_stale_profile_path_prefix
make test:integration:cli FILTER=whoami
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/cli/src/commands/auth/whoami.rs src/cli/tests/auth.rs
git commit -m "fix(cli): refresh path prefix from whoami"
```

## Task 3: API WebSocket Attach OIDC Auth

**Files:**
- Modify: `apps/api/src/boxlite-rest/boxlite-ws-proxy.service.ts`
- Test: existing or new Jest spec near `apps/api/src/boxlite-rest/`

**Step 1: Write failing tests**

Create or extend a spec that instantiates `BoxliteWsProxyService` with mocked services.

Cases:

- API key token returns organization id as today.
- JWT-shaped token falls through to OIDC/JWT verification.
- Invalid JWT returns `null`.
- Removed organization membership returns `null`.

Expected structure:

```ts
it('authenticates JWT bearer tokens for websocket attach', async () => {
  jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user_1', email: 'dev@acme.test' })
  userService.findOne.mockResolvedValue({ id: 'user_1' })
  organizationUserService.findOneByUserId.mockResolvedValue({ organizationId: 'org_1' })

  const req = { headers: { authorization: 'Bearer header.payload.signature' } } as IncomingMessage

  await expect(service.authenticateForTest(req)).resolves.toEqual({ organizationId: 'org_1' })
})
```

If private method testing is awkward, expose a package-private/test-only helper only if there is an existing local pattern. Otherwise test through `upgrade()` with a fake socket and mocked downstream services.

**Step 2: Run to verify failure**

Run the smallest app test target available in Makefile. If no narrow make target exists, use the repo's app test target:

```bash
make test:apps FILTER=boxlite-ws-proxy
```

Expected: FAIL because WS auth is API-key only.

**Step 3: Implement JWT path**

Inject the existing JWT verifier dependency used by `JwtStrategy` or a small internal auth service if one already exists. Keep API-key first.

Implementation rules:

- If token is not JWT-shaped, preserve API-key behavior.
- If token is JWT-shaped, verify issuer/audience/signature.
- Resolve user and organization membership the same way HTTP guarded requests do.
- Return `{ organizationId }`.
- Do not forward the user OIDC token to Runner. Continue forwarding Runner API key in `proxyReqWs`.

**Step 4: Run tests**

```bash
make test:apps FILTER=boxlite-ws-proxy
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/boxlite-rest/boxlite-ws-proxy.service.ts apps/api/src/boxlite-rest/*spec.ts
git commit -m "fix(api): allow OIDC websocket attach auth"
```

## Task 4: REST E2E Auth Matrix Fixtures

**Files:**
- Modify: `scripts/test/e2e/cases/conftest.py`
- Modify or create: `scripts/test/e2e/fixture_setup.py`
- Create: `scripts/test/e2e/cases/test_oidc_cli_smoke.py` if CLI smoke belongs in pytest.

**Step 1: Add fixture branch**

Support:

```bash
BOXLITE_E2E_AUTH=api-key
BOXLITE_E2E_AUTH=oidc
```

For API key, keep current behavior.

For OIDC:

- Read `oidc_access_token` or equivalent from profile/env.
- Use `boxlite.BearerTokenCredential` if available; otherwise use the SDK's OIDC-capable credential type.
- Preserve `path_prefix`.

**Step 2: Add focused OIDC case**

Add one OIDC-only smoke:

```python
@pytest.mark.asyncio
async def test_oidc_exec_stdout(rt, image):
    box = await rt.create(boxlite.BoxOptions(image=image, auto_remove=True))
    try:
        ex = await box.exec(["sh", "-lc", "echo hi-from-oidc"])
        out, err = await drain(ex)
        assert "hi-from-oidc" in out
    finally:
        await rt.remove(box.id, force=True)
```

Skip with a clear message if `BOXLITE_E2E_AUTH != "oidc"`.

**Step 3: Verify local API-key path**

Run:

```bash
make test:rest:e2e AUTH=api-key FILTER=oidc_exec_stdout
```

Expected: skip or pass depending on marker design, with no API-key regression.

**Step 4: Commit**

```bash
git add scripts/test/e2e
git commit -m "test: add REST E2E auth matrix"
```

## Task 5: REST Make Targets and Report

**Files:**
- Modify: `make/test.mk`
- Create: `scripts/test/rest/run_cli_smoke.sh`
- Create: `scripts/test/rest/report.py`

**Step 1: Add targets**

Add:

```make
test\:rest\:contract:
	@python3 scripts/test/rest/contract.py

test\:rest\:e2e:
	@BOXLITE_E2E_AUTH=$${AUTH:-api-key} cd scripts/test/e2e && python3 -m pytest cases/ -v $(PYTEST_FILTER)

test\:rest\:cli:
	@scripts/test/rest/run_cli_smoke.sh "$${AUTH:-oidc}"

test\:rest\:report:
	@python3 scripts/test/rest/report.py
```

If shell scoping makes the env assignment invalid, use:

```make
test\:rest\:e2e:
	@cd scripts/test/e2e && BOXLITE_E2E_AUTH=$${AUTH:-api-key} python3 -m pytest cases/ -v $(PYTEST_FILTER)
```

**Step 2: Implement CLI smoke**

`run_cli_smoke.sh` should run:

```bash
boxlite auth whoami
boxlite ls
boxlite run --image "${BOXLITE_REST_SMOKE_IMAGE:-alpine:3.23}" -- sh -lc 'echo hi-from-cli'
```

Adjust exact CLI command after confirming current CLI syntax.

**Step 3: Implement report**

Aggregate:

- `target/rest-test-report/rest-inventory.md`
- pytest output path if present
- CLI smoke output path if present

**Step 4: Commit**

```bash
git add make/test.mk scripts/test/rest
git commit -m "test: add REST test command surface"
```

## Task 6: Runbook Documentation

**Files:**
- Create: `docs/testing/rest-api-e2e.md`
- Modify: `docs/plans/2026-06-16-rest-api-e2e-oidc-design.md` only if design changes during implementation.

**Step 1: Write runbook**

Include:

- What exists vs what is new.
- How to run API-key path.
- How to run OIDC path.
- How to run on dev machine.
- When API restart is allowed.
- How to collect logs.
- Common failure table.

**Step 2: Commit**

```bash
git add docs/testing/rest-api-e2e.md docs/plans/2026-06-16-rest-api-e2e-oidc-design.md
git commit -m "docs: add REST E2E runbook"
```

## Task 7: Dev Validation

**Files:**
- Output only: `target/rest-test-report/dev-validation-YYYYMMDD.md`

**Step 1: Prepare dev machine**

- Sync latest branch.
- Build CLI/API as needed.
- Do not restart API until build is ready.

**Step 2: Restart dev API if API code changed**

Use the existing dev deployment/restart path for API only. Do not restart Runner unless necessary.

**Step 3: Run validation**

Run:

```bash
make test:rest:inventory
make test:rest:e2e AUTH=api-key
make test:rest:cli AUTH=oidc
make test:rest:e2e AUTH=oidc FILTER=oidc_exec_stdout
make test:rest:report
```

**Step 4: Save report**

Record:

- Branch and commit.
- Dev API target.
- CLI binary path/version.
- API key result.
- OIDC result.
- API/Runner log locations.
- Any skipped or failed items.

**Step 5: Final commit if report is committed**

Only commit dev validation artifacts if they are intended to live in the repo. Otherwise keep them as run artifacts.
