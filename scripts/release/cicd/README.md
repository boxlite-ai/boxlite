# Release control-plane tooling (Task 21)

Pure-logic building blocks for the standardized release pipeline. Everything here
operates on **data + fixtures** (no AWS / registries / CI), so it is unit-tested
in isolation. The workflows that feed these real `sst diff` / DB state / build
outputs are wired separately (not in this PR — see "Not done" below).

## Modules

| Module | What it does | Task # |
|---|---|---|
| `manifest.py` | parse + validate `release.yaml` (the WHAT-to-ship contract) | #1 |
| `artifact_manifest.py` | the immutable build-once artifact record deploy trusts (digest-pinned) | #3 |
| `preflight.py` | pre-apply gates: resource diff, **DB baseline**, **DNS collision** | #8 / DB+DNS pitfalls |
| `ledger.py` | release ledger + `last_good_sha` for Cloud rollback | #11 / #16 |
| `versions.py` | OSS single-version-source drift check | version drift |

`validate_manifest.py` is the CLI: `python3 scripts/release/validate_manifest.py <release.yaml>`
(exit 0 valid / 1 invalid). `release.example.yaml` is a runnable example.

## Why the gates exist (real incidents this guards)

- **DB baseline gate** encodes the `1741/1753` drift class: db ran a migration the
  baseline doesn't know (divergent branch), OR baseline recorded but the table was
  never built ("relation does not exist"). Either drift → blocked before apply.
- **DNS preflight** blocks a record that another stage already owns (cross-stage
  collision), the kind of footgun a shared Cloudflare zone invites.
- **resource gate** blocks `replace`/`delete` on stateful resources (Runner/RDS/
  Redis) unless explicitly overridden — routine deploys must never nuke state.

## Run the tests

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install pytest pyyaml
cd scripts/release && python -m pytest -q          # 37 tests, ~0.05s
```

## Status

**Done + verified here (pure logic, 37 tests, mutation-checked):** all five modules
above + the validate CLI.

**Not done (needs CI / AWS — can't be verified solo, intentionally out of this PR):**
- GitHub Actions that *call* these (`release-build.yml` / `release-plan.yml` /
  `release-apply.yml`) — authoring them is fine, but they can only be verified on CI.
- The adapters that produce real inputs: run `sst diff` → feed `preflight.parse_sst_diff`;
  query the `migrations` table → `db_baseline_gate`; list Cloudflare records → `dns_preflight`.
- A `make test:release-tooling` target + CI job to run this suite in PRs.
- Version *writeback* (this only *checks* drift; rewriting the 7 sites is separate).
