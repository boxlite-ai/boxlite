# Test Report — copy_in/copy_out parity

**Branch:** `feat/copy-in-copy-out`
**Host:** macOS Apple Silicon (M5), real libkrun boxes
**Date:** 2026-06-01
**Under test:** REST/serve/CLI docker-cp parity + C/Go/Python SDK alignment, after **two review rounds** of fixes (round 1: REST empty-path fail-fast, comments, C options doc; round 2: E2E `cp` exit-code assertions, infallible `download_files` response, REST/local guard-order parity — see [Review rounds](#review-rounds)). See [spec](./copy-in-copy-out-parity.md).

## Summary

| Suite | Scope | Result |
|-------|-------|--------|
| Rust unit `rest::litebox` (pack/extract) | 5 | ✅ 5/5 |
| Rust integration `tests/copy.rs::copy_integration` (local backend, real box) | ~18 sub-checks | ✅ PASS |
| E2E `scripts/test/cli-e2e/copy-parity.sh` (each scenario on **local + serve**) | 13 scenarios → 18 assertions (incl. `cp` exit-code checks) | ✅ 18/18 |
| Go SDK `TestIntegrationCopyOptions` (local backend) | 10 subtests | ✅ 10/10 |
| Python SDK (async + sync) | 2 | ✅ 2/2 |
| Quality gates: `cargo fmt`, clippy (boxlite · boxlite-cli · boxlite-c), `gofmt`/`go vet`, `ruff`, `bash -n` | — | ✅ clean |

## E2E scenarios × results (local and serve assert byte-identical SHA)

| # | Dir | Scenario | Expected | Result |
|---|-----|----------|----------|--------|
| 1 | in  | file → nonexistent path | regular file at exact path | ✅ |
| 2 | in  | file → existing dir | lands at `dir/file` | ✅ |
| 3 | in  | dir `include_parent=true` | keep `dst/dir/…` | ✅ |
| 4 | in  | dir `--no-include-parent` | flatten into `dst` | ✅ |
| 5 | in  | file → existing file `--no-overwrite` | `cp` exits non-zero (both backends) **and** original unchanged | ✅ |
| 6 | in  | dir with symlink (default) | symlink preserved | ✅ |
| 7 | in  | dir with symlink `--follow-symlinks` | dereferenced to regular file | ✅ |
| 8 | out | box file → nonexistent host path | regular file (F-010) | ✅ |
| 9 | out | box dir `--no-include-parent` | flatten into host dir | ✅ |
| 10 | out | box dir `include_parent=true` | keep `host/dir/…` | ✅ |
| 11 | out | box file → existing host file `--no-overwrite` | box source present (asserted) → `cp` exits non-zero (both backends) **and** host file unchanged | ✅ |
| 12 | out | box dir with symlink (default) | symlink preserved | ✅ |
| 13 | out | box dir with symlink `--follow-symlinks` | dereferenced to regular file | ✅ |

## Go subtests — `TestIntegrationCopyOptions` (local backend, real box)

[`sdks/go/copy_integration_test.go`](../../sdks/go/copy_integration_test.go) — 10 subtests.
Box state asserted via `test -f/-d/-L` exit codes inside the box; host state via `os.Stat`/`os.Lstat`.

| # | Subtest | Dir / option | Assertion | Result |
|---|---------|--------------|-----------|--------|
| 1 | default keeps parent dir | copy_in dir, default | `/root/d1/pkg/a.txt` is a file (keeps `pkg/`) | ✅ |
| 2 | WithIncludeParent(false) flattens | copy_in dir, `include_parent=false` | `/root/d2/a.txt` is a file; `/root/d2/pkg` absent | ✅ |
| 3 | WithOverwrite(false) rejects existing | copy_in file → existing file, `overwrite=false` | returns error; box file unchanged | ✅ |
| 4 | copy_out single file to exact path | copy_out file → nonexistent host path | host is a regular file, content matches | ✅ |
| 5 | follow_symlinks: default preserves / WithFollowSymlinks derefs | copy_in dir with symlink | default `-L` holds (link kept); follow → `-L` false, `-f` true (dereferenced) | ✅ |
| 6 | WithRecursive(false) rejects a directory source | copy_in dir, `recursive=false` | returns error | ✅ |
| 7 | copy_out dir default keeps parent dir | copy_out dir, default | host `<dir>/op/y.txt` is a file | ✅ |
| 8 | copy_out WithOverwrite(false) leaves host file | copy_out file → existing host file, `overwrite=false` | returns error; host file unchanged | ✅ |
| 9 | copy_out follow_symlinks: default preserves / follow derefs | copy_out box dir with symlink | default `os.Lstat` = symlink; follow → regular file | ✅ |
| 10 | copy_out WithIncludeParent(false) flattens | copy_out dir, `include_parent=false` | host has `z.txt` directly, no `odf/` wrapper | ✅ |

Go is the only surface that exercises `recursive=false` (#6); CLI/Python don't expose it.

## Python tests

### async — `tests/test_copy.py::test_copy_option_semantics` (9 sections)

[`sdks/python/tests/test_copy.py`](../../sdks/python/tests/test_copy.py) — box state via `test` exit codes, host state via `is_file()`/`os.path.islink()`.

| # | Section | Dir / option | Assertion | Result |
|---|---------|--------------|-----------|--------|
| 1 | copy_in dir default | `include_parent=True` | `/root/d1/pkg/a.txt` is a file | ✅ |
| 2 | copy_in dir flatten | `include_parent=False` | `/root/d2/a.txt` is a file; no `pkg/` | ✅ |
| 3 | copy_in overwrite | `overwrite=False` onto existing file | `pytest.raises`; original unchanged | ✅ |
| 4 | copy_out single file | → exact host path | host regular file + content | ✅ |
| 5 | copy_in symlink | default / `follow_symlinks=True` | `-L` preserved / dereferenced to `-f` | ✅ |
| 6 | copy_out dir default | `include_parent=True` | host `op/y.txt` is a file | ✅ |
| 7 | copy_out overwrite | `overwrite=False` onto existing host file | `pytest.raises`; host unchanged | ✅ |
| 8 | copy_out symlink | default / `follow_symlinks=True` | host `os.path.islink` preserved / dereferenced | ✅ |
| 9 | copy_out dir flatten | `include_parent=False` | host `z.txt`, no `odf/` wrapper | ✅ |

### sync — `tests/test_sync_simplebox.py::test_copy_in_out_options` (4 sections)

[`sdks/python/tests/test_sync_simplebox.py`](../../sdks/python/tests/test_sync_simplebox.py) — validates the newly-added `SyncSimpleBox.copy_in`/`copy_out` (the sync wrapper previously had no copy methods). Symlink / copy_out-flatten are covered by the async suite and not duplicated here.

| # | Section | Option | Assertion | Result |
|---|---------|--------|-----------|--------|
| 1 | copy_in dir default | keep-parent | `/root/d1/pkg/a.txt` | ✅ |
| 2 | copy_in flatten | `include_parent=False` | `/root/d2/a.txt`; no `pkg/` | ✅ |
| 3 | copy_in overwrite | `overwrite=False` | fails; original unchanged | ✅ |
| 4 | copy_out single file | → exact host path | host regular file + content | ✅ |

## Coverage notes

- Every **expressible** scenario is a real test on its surface. `recursive=false` is only
  expressible via Go (`WithRecursive(false)`) and the Rust integration suite — the CLI has no
  recursive flag and Python `copy_in` has no `recursive` kwarg.
- The C SDK copy path is validated **via Go** (both call the same `*_with_options` C ABI +
  `CBoxCopyOptions`), per the project convention that native-API C coverage lives in the Go SDK.
- Two-side TDD was performed on the load-bearing fixes: the `extracted/` leak, the dropped
  `overwrite`, and the pack-options divergence.

## Process notes (environment, not code issues)

1. **Go first run failed, then resolved.** Rebuilding the CLI (`make cli`) changed the embedded
   runtime manifest hash, leaving the previously-built `target/debug/libboxlite.a` out of sync with
   the new runtime (`mke2fs not found`). Re-syncing with `make dev:go` fixed it → 10/10 pass. This
   is build staleness, **not a code regression** (the change is unrelated to disk/mke2fs).
2. **`ws_watchdog_fires_when_idle`** in the rest unit suite is a pre-existing timing flake (also
   fails on `origin/main`); unrelated to this work.
3. **The two Python copy test files cannot run in one pytest invocation** (they contend for the
   `~/.boxlite` single-instance flock); run separately, both pass.

## Review rounds

Two independent code-review passes (fresh-context subagents) were run; neither found a blocker.

**Round 1** (production code): 3 should-fix → all addressed.
- REST `copy_into`/`copy_out` now fail-fast on an empty path (mirrors the local backend) so direct SDK/REST callers match the CLI.
- Comment documenting that `include_parent`/`follow_symlinks` are applied client-side at pack time for `copy_into` (baked into the tar) and so — unlike `copy_out` — are not sent as query params.
- C `CBoxCopyOptions` doc: a non-NULL struct must set every field (a zeroed struct yields `include_parent=false`, opposite the default; pass NULL for defaults).

**Round 2** (production + tests, with a focus on test false-pass risks): 3 should-fix → all addressed.
- **E2E `--no-overwrite` false-pass closed.** The two no-overwrite scenarios pre-seed the destination with the expected content, so a `cp` that silently no-ops (or errors for an unrelated reason) could have passed the unchanged-content check. Fixed by asserting the `cp` itself exits non-zero (`expect_fail`, both backends) and, for copy_out, asserting the box source is present first — so a refusal is provably the overwrite rejection, not a missing-source error.
- **`download_files` success response** is now built infallibly (typed `Content-Type` header + owned body via `into_response()`) instead of `Response::builder()...unwrap()`, removing a latent serve-worker panic path.
- **Empty-path guard order** in REST `copy_into` reordered (`validate_for_dir` before the empty-dst check) to match `box_impl`, so identical inputs yield identical errors on both paths.

Remaining items were nits judged not worth changing (e.g. the overwrite-conflict HTTP status staying 500 rather than 409 — re-classifying would touch the shared error taxonomy, out of scope per spec §6).

## Conclusion

After two review rounds and their fixes, every expressible scenario is green on every surface, and
the E2E suite now also proves that `--no-overwrite` copies genuinely fail (not silently no-op).
Happy path: **E2E 18/18**, with local and serve producing byte-identical results;
Go 10/10, Python 2/2, Rust unit 5/5 + integration green; all quality gates clean.
