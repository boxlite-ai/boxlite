# copy_in/copy_out parity — before/after problems & verification

Companion to the [design spec](./copy-in-copy-out-parity.md) and
[test report](./copy-in-copy-out-parity-test-report.md). Documents what was
broken **before** this branch (per surface and direction), proves each problem
existed by reproducing it on the baseline code, and records the **after** state
with its supporting evidence.

- **Baseline (before)** = `0bf0b3a3` (#624), i.e. all of this branch's changes reverted.
- **After** = branch HEAD on `feat/copy-in-copy-out`.

---

## 1. Problems before this branch (surface × direction), reproduced on baseline code

| Surface | copy-in (host→box) problem | copy-out (box→host) problem | Reproduction on baseline `0bf0b3a3` + observed result |
|---|---|---|---|
| **CLI local** (`boxlite cp`, no `--url`) | Behavior itself correct (local backend is the reference); the one defect: `--include-parent` is a presence-only flag, so it **cannot be set to false** → no way to express "flatten" from the CLI | Same: behavior correct, `include_parent` likewise not settable to false | **A** — old binary `cp --include-parent=false a.txt BOX:/a.txt` → `error: unexpected value 'false' for '--include-parent' found` ✅ confirms it can't be set false (the copy itself is correct, no bug to reproduce) |
| **REST CLI** (`boxlite cp --url`, REST client + serve) | ① **all `CopyOptions` dropped** (overwrite/include_parent/follow_symlinks have no effect)<br>② **`extracted/` leak**: the destination becomes a **directory** `dst/extracted/<name>` instead of the file/dir at `dst` | ① **options dropped** (same)<br>② **F-010**: `extract_tar_to_path` calls `archive.unpack(host_dst)`, unpacking the tar **into a freshly-created directory** rather than the file at the exact path | **B** (copy-in `extracted/`) `cp leak.txt rb-serve:/root/leak.txt` → `/root/leak.txt` is actually a **directory** containing `extracted/leak.txt` ✅<br>**C** (copy-out F-010) `cp rb-serve:/root/c.txt <nonexistent-host>` → the host destination is actually a **directory** containing `c.txt` ✅<br>**① options dropped**: code-level fact (`_opts: CopyOptions` is unused — git-verified); at runtime it is masked by the B/C structural bugs — **D** `cp --no-overwrite new.txt rb-serve:/root/ov.txt` (ov.txt exists) → `exit=1`, i.e. the old REST copy-in fails outright onto an existing-file destination (the `extracted/` leak tries to create a directory where a file already is), so the option never gets a chance to take effect |
| **SDK — C** | **Exposes no options**; hardcodes default **`include_parent=false` (flatten)**, opposite core/Node/Python | Same: no options + flatten default | Source: `default_copy_options()` = `include_parent: false`, no `*_with_options`. Runtime confirmed via Go (same C ABI) — see next row ✅ |
| **SDK — Go** | **Exposes no options** (`CopyInto(ctx, src, dst)` has no opts param); default inherits C = **flatten** | Same | **Go runtime** `TestReproDefaultFlatten` (old SDK): `CopyInto(dir, "/root/dd")` default → `/root/dd/a.txt` present (exit 0, **flattened**), `/root/dd/pkg` **absent** (exit 1) → confirms default flatten, opposite the core/Python keep-parent default ✅ |
| **SDK — Python sync** (`SyncSimpleBox`) | **No `copy_in`/`copy_out` methods at all** (capability gap) | **None** (same) | Baseline `SyncSimpleBox` defines 0 copy methods (only `__init__/exec/stop/info/...`) → `box.copy_in(...)` raises **`AttributeError`** ✅ |
| **SDK — Python async** (`SimpleBox`) | Correct (all options, default keep-parent); over REST it inherits the REST problems | Correct; over REST inherits the REST problems | No bug (local path correct) → nothing to reproduce; via `--url` it would hit REST B/C above |
| **SDK — Node** | Correct (`JsCopyOptions` forwards all 4 fields, defaults from core) — no problem | Correct — no problem | No bug → nothing to reproduce |

**In one line:** before this branch, only the **local backend** (and Node / Python-async on the local path) was fully correct; the **REST chain dropped all options and had a structural bug in each direction**; **C/Go exposed no options and defaulted to flatten**; **Python sync had no copy**; and the **CLI could not express `include_parent=false`**.

### Reproduction method & environment (the "before" side of two-sided verification)

- **Old code** = a git worktree at baseline `0bf0b3a3` (before any of this branch's changes), built independently with `make cli` + `make dev:go`.
- **A/B/C/D** — a reproducer script ran the old `boxlite` binary against an old `serve`, on a real box (M5 libkrun), printing an OBSERVED line per problem (the table above is that output).
- **Go flatten** — a temporary `TestReproDefaultFlatten` in the baseline `sdks/go`, `go test -tags boxlite_dev`, real box.
- **C default / Python-sync** — source-level facts (the default constant / the missing methods), whose runtime consequences were confirmed via Go (same C ABI) and an `AttributeError` respectively.
- **Conclusion:** every "before" problem was reproduced on the baseline code (or proven at source plus an equivalent-ABI runtime check), so each is confirmed to have existed before the change. Together with the "after" results (E2E 18/18 etc.) this forms complete two-sided verification.

---

## 2. Before → after: behaviors brought to parity

| Behavior | Before | After (identical across local / REST / serve / SDK, docker-cp semantics) |
|---|---|---|
| file → exact path vs into an existing directory | REST wrong in both directions (copy-in `extracted/` leak / copy-out F-010 writes a directory) | byte-identical to local: single file → nonexistent = exact file, → existing dir = `dir/file` |
| `include_parent` (keep dir name / flatten) | REST dropped; C/Go defaulted the opposite (flatten); CLI couldn't set false | defaults `true` (keep-parent) everywhere, settable to false everywhere (CLI `--no-include-parent`, SDK options, REST query) |
| `overwrite` (false refuses to clobber) | REST dropped | honored over REST/SDK; on refusal `cp` genuinely exits non-zero |
| `follow_symlinks` (dereference / preserve) | REST dropped | honored over REST/SDK, both directions |
| `recursive=false` errors on a directory | only in the local backend | REST client + Go also fail-fast (REST matches box_impl ordering; CLI/Python don't expose it, so can't trigger) |
| synchronous Python copy | did not exist | `SyncSimpleBox.copy_in/copy_out` added, mirroring the async API |
| tar implementation | REST had its own `append_dir_all(".")` (produces a `.` entry) | client/serve use `boxlite_shared::tar` exclusively; the divergent impl removed |

**Core:** with the local backend as the single source of truth, the REST client, the serve server, and the C/Go/Python-sync SDKs were all aligned to one set of docker-cp semantics and defaults; Node and Python-async were already correct and unchanged.

---

## 3. Verification of the "before" claims against baseline `0bf0b3a3` (git evidence)

| Claim | Baseline evidence (`git show 0bf0b3a3:<file>`) | Verdict |
|---|---|---|
| CLI `--include-parent` presence-only, can't set false | `cp.rs:18` `#[arg(long, default_value_t = true)] pub include_parent: bool` | ✅ |
| CLI already has `--follow-symlinks` / `--no-overwrite` | `cp.rs:10-15` (default false) | ✅ |
| REST `copy_into`/`copy_out` drop opts | `rest/litebox.rs:212/249` `_opts: CopyOptions` | ✅ |
| REST bespoke tar (`append_dir_all(".")`) | `rest/litebox.rs:860-864` `create_tar_from_path` | ✅ |
| REST copy-out F-010 (unpack into a created dir) | `rest/litebox.rs:907` `archive.unpack(host_dst)` | ✅ |
| REST copy-in `extracted/` leak | `serve/handlers/files.rs:39` `join("extracted")` + `:60` `copy_into(…, CopyOptions::default())` | ✅ |
| serve copy-out drops options + re-packs | `files.rs:92` `copy_out(…, default())` + `:100` `append_dir_all(".")` | ✅ |
| C SDK no options, default `include_parent=false` | `sdks/c/src/copy.rs:15` only `boxlite_copy_into(` (no `*_with_options`) + `:43` `include_parent: false` | ✅ |
| Go SDK `CopyInto(ctx,src,dst)` no opts param | `sdks/go/copy.go:15` signature has no `CopyOption`/`opts ...` | ✅ |
| Node SDK correct (all 4 fields forwarded) | `sdks/node/src/copy.rs:5-25` `JsCopyOptions` forwards all | ✅ |
| Python async correct (all options, default keep-parent) | `simplebox.py:317-324` `copy_in(... overwrite=True, follow_symlinks=False, include_parent=True)` | ✅ |
| Python sync `SyncSimpleBox` has no copy methods | `sync_api/_simplebox.py` has `def exec`(155)/`def stop`(258), **no** `copy_in/copy_out` | ✅ |
| CLI local behavior itself correct (baseline) | `tests/copy.rs::copy_integration` passes; F-010/extracted only on REST | ✅ |

Every "before" problem has baseline `file:line` evidence; all confirmed real.

---

## 4. After state + proof (branch HEAD)

| Behavior | After state | Proof (code + tests) |
|---|---|---|
| file/dir destination detection (docker-cp) | local and REST **byte-identical**: single file → nonexistent = exact file, → existing dir = `dir/file` | Code: `shared/src/tar.rs::detect_extraction_mode`; REST receiver `rest/litebox.rs::extract_tar_to_path` (F-010 fix). Tests: E2E #1/#2/#8 (local+serve same SHA), Rust unit `unpack_single_file_*` / `issue_238` / `f010_*` |
| `include_parent` (default true, settable false) | keep-parent by default; flattenable from CLI/SDK/REST | Code: `cp.rs` `--no-include-parent`; `sdks/c/src/copy.rs` default `include_parent: true` + `CBoxCopyOptions`; `sdks/go/copy.go` `WithIncludeParent`; `serve/handlers/files.rs` bridges with `include_parent:false`. Tests: E2E #3/#4/#9/#10, Go `WithIncludeParent(false) flattens` / `copy_out … flattens`, Python flatten sections |
| `overwrite` (false refuses, cp exits non-zero) | honored over REST/SDK; refusal provable (command actually fails) | Code: client sends `?overwrite=`, guest enforces at unpack; `extract_tar_to_path(overwrite)`. Tests: E2E `expect_fail` #5/#11 (non-zero exit on both backends) + content unchanged, Rust `extract_overwrite_false_rejects_existing_file`, Go/Python overwrite sections |
| `follow_symlinks` (dereference / preserve) | honored over REST/SDK, both directions | Code: copy-out sends `?follow_symlinks=` (guest packs), copy-in applies it client-side at pack. Tests: E2E #6/#7/#12/#13, shared `pack_follow_symlinks_*`, Go/Python symlink sections |
| `recursive=false` errors | REST client + Go + local all fail-fast | Code: `rest/litebox.rs::copy_into` calls `validate_for_dir` (same order as box_impl). Tests: Go `WithRecursive(false) rejects`, Rust integration `non_recursive_rejects_directory` (CLI/Python don't expose it, so can't trigger) |
| `extracted/` leak | eliminated | Code: `serve/handlers/files.rs::stage_upload_tar` unpacks into `staged/` + `copy_into(include_parent:false)`. Tests: `upload_staging_tests::staged_dir_has_no_extracted_wrapper`, E2E #1 (serve), two-sided TDD |
| serve success response | infallible (no `.unwrap()`) | Code: `download_files` uses `(StatusCode, [(CONTENT_TYPE,…)], body).into_response()` |
| synchronous Python copy | exists | Code: `sync_api/_simplebox.py::copy_in/copy_out`. Test: `test_sync_simplebox.py::test_copy_in_out_options` |
| tar implementation | unified `boxlite_shared::tar` | `create_tar_from_path` / `append_dir_all(".")` removed; clippy `-D warnings` clean |
| C SDK copy path | validated via Go (same `*_with_options` + `CBoxCopyOptions` C ABI) | per project convention native-API C coverage lives in the Go SDK; Go 10/10 |
| Node SDK | unchanged (already correct) | `git diff 0bf0b3a3..HEAD` does not touch `sdks/node` |

### Test overview (after, real boxes on M5)

| Suite | Result |
|---|---|
| Rust unit `rest::litebox` (pack/extract) | ✅ 5/5 |
| Rust integration `tests/copy.rs::copy_integration` | ✅ PASS (~18 sub-checks) |
| E2E `scripts/test/cli-e2e/copy-parity.sh` (local + serve) | ✅ 18/18 |
| Go `TestIntegrationCopyOptions` | ✅ 10/10 |
| Python (async + sync) | ✅ 2/2 |
| fmt · clippy (boxlite · boxlite-cli · boxlite-c) · gofmt·vet · ruff · bash -n | ✅ clean |
