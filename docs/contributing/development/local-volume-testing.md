# Local volume test runbook

Use this runbook for changes to local managed volumes: the store, box holder lifecycle, archive
round trips, CLI mounts, guest resolved mounts, the REST volume API, or the existing Python
`volumes` dictionary API. It tests the local runtime and the server-backed REST API; cloud and
runner behavior are out of scope.

Run every command from the repository root unless the command changes directory itself. Execute the
steps in order and keep the output needed to identify which tests actually ran.

## Evidence rules

- Use the Make targets below so builds retain the required features, runtime artifacts, and ordering.
- A passing command must exit zero **and run the intended tests**. A filter that matches zero tests,
  a platform skip, or a successful build alone is not test coverage.
- Fix failures caused by the change before continuing. Record unrelated or pre-existing failures
  separately, with evidence; never turn a red suite into a reported pass.
- When fixing a defect, also perform the defect proof in
  [`AGENTS.md`](../../../AGENTS.md#defect-proof). A passing test without the failing pre-fix run does
  not prove the fix.
- Do not commit or create a PR unless the user asked for it.

## 1. Prepare and record the environment

Inspect the working tree before testing so existing changes are preserved:

```bash
git status --short --branch
uname -s -m
```

For a checkout that has not been set up, initialize submodules and install the platform dependencies:

```bash
git submodule update --init --recursive
make setup
```

The M3 matrix requires cargo-nextest. If `cargo nextest --version` fails on an existing checkout, run
`make setup` to install the missing test tool before invoking the matrix.

The VM tests require a supported local hypervisor: macOS ARM64 with Hypervisor.framework, or Linux
with KVM. On Linux, verify that KVM is usable before starting the VM suites:

```bash
test -r /dev/kvm -a -w /dev/kvm
```

Step 1 is complete when the required tools are present, the platform is recorded, and any unavailable
hypervisor is reported as a blocker rather than replaced with compile-only checks.

## 2. Run the fast Rust loop

Format and lint first, then run the volume-focused unit tests:

```bash
make fmt:rust
make clippy
make test:unit:rust FILTER=volume
```

The focused filter is a development loop, not the final Rust gate. Before finishing any code change,
run the complete unit suite so archive, import, VMM grants, and lifecycle tests without `volume` in
their names are included:

```bash
make test:unit:rust
```

Step 2 is complete when Clippy and the full unit suite pass. If only a focused run has completed,
report the remaining full-suite run explicitly.

## 3. Run guest tests on Linux

On Linux, run the guest suite. It includes the resolved-mount cleanup, read-only, path-replacement,
and unsupported-`openat2` tests:

```bash
make test:unit:guest
```

On macOS, record these tests as **not run; Linux required**. The Make target's successful skip is not
a guest test pass. A change to `src/guest/src/storage/resolved_mount.rs` is not fully verified until
this suite has run on Linux.

## 4. Exercise real VM paths

Run the local-volume CLI scenarios:

```bash
make test:integration:cli FILTER=local_volume
```

Confirm that the output contains all three test names:

- `local_volume_complete_lifecycle`
- `local_volume_rejects_duplicate_mounts`
- `local_volume_remove_waits_for_last_holder`

The lifecycle case creates a volume, writes and reads through separate real VMs using `--rm`,
verifies that no boxes remain, removes the volume, and confirms that a subsequent get fails.

When the mount protocol or guest bind dispatch changes, also verify the pre-existing single-file
host-bind contract:

```bash
make test:integration:cli FILTER=test_run_with_single_file_volume
```

Confirm that `test_run_with_single_file_volume` ran and read the staged file through a real VM.

Run an archive round trip:

```bash
make test:integration:rust FILTER=test_export_import_roundtrip
```

Confirm that `test_export_import_roundtrip` ran. These CLI and archive tests build and boot real VMs;
allow the Make targets to finish instead of substituting `cargo check` or importing a library.

On Linux, also run the existing host-directory compatibility cases through the explicit-engine M3
matrix. The ordinary integration target lists these cases as ignored, so a zero-exit filtered run is
not evidence that they executed:

```bash
make test:integration:vmm:m3 ENGINE=krun FILTER=directory_volumes
```

Confirm that the two-, three-, eight-, and thirty-two-directory cases all ran and passed. If the
matrix reports a missing `VMM_KERNEL`, run `make vmm:boot` and then rerun the matrix. Use
`ENGINE=native` instead when the change affects the native VMM path. On macOS, record the M3 matrix
as **not run; Linux KVM required**.

Step 4 is complete when the three CLI scenarios and archive round trip pass, plus all four M3
directory cases on Linux. On a host without a usable hypervisor, skip the remaining VM steps and
continue to the final report with that coverage marked as blocked.

For REST API changes, start a real `boxlite serve` process and drive its volume endpoints:

```bash
make test:e2e:serve:volume
```

This Make entry runs `volume_crud_over_rest` with the CLI integration target and skips rebuilding
runtime artifacts when `SETUP_DONE=1` is already set. Confirm that `volume_crud_over_rest` ran. It
creates a named volume through the Rust REST client, checks list and get metadata, verifies the
invalid-id and missing-volume error classes, removes the volume, and confirms that both get and
list reflect the removal. Unlike the local CLI scenarios, this case does not boot a VM; it verifies
server startup, routing, persistence-backed CRUD, and HTTP error mapping. CI runs this case in the
`REST Server E2E (Linux)` job.

REST coverage is complete when this named test runs; it does not replace the real-VM coverage above
when the mount or guest protocol changes.

## 5. Verify the Python compatibility path

Run the standard target first:

```bash
make test:integration:python FILTER=local_volume
```

Confirm that `test_local_volume_shared_by_boxes_clone_and_import` ran. It verifies that clone and
import still read the original volume data and that removing a volume remains blocked while any box
references it.

### Python 3.9 fallback

The standard target uses the repository's `.venv`. If it fails **before test collection** because
that interpreter is Python 3.9 while the SDK requires Python 3.10 or later, use this isolated Python
3.12 fallback. Do not use the fallback to bypass a test assertion or another build failure.

```bash
set -euo pipefail
venv="$(mktemp -d /tmp/boxlite-py312-XXXXXX)"
trap 'rm -rf "$venv"' EXIT
python3.12 -m venv "$venv"
"$venv/bin/pip" install -q uv maturin pytest
export VIRTUAL_ENV="$venv"
export PATH="$venv/bin:$PATH"
(
  cd sdks/python
  "$venv/bin/maturin" develop --uv
  "$venv/bin/python" -m pytest tests/test_local_volume.py -v
)
```

This fallback intentionally builds through Maturin outside the hardcoded `.venv`; the normal Make
target remains the required path on a supported interpreter. The trap removes the temporary
environment when the shell exits. If Python 3.12 is unavailable, report the SDK test as blocked.

After Python source or test changes, run:

```bash
make lint:python
make fmt:check:python
```

Step 5 is complete when the named integration test has run under a supported interpreter and the
Python checks pass. Disclose whether the standard target or fallback produced the evidence.

## 6. Run broader core regression suites

Before merging a runtime or lifecycle change, run:

```bash
make test:unit:core
make test:integration:core
```

These suites are broader and slower than the focused checks. A timeout is not a pass: identify the
unexecuted tests and rerun them with specific Make-target filters, or report the incomplete suite.

On macOS, `TestMitmProxy_HTTP2_MultiplexedStreams` in the gvproxy bridge has been observed failing
independently of local-volume work. Do not classify it as unrelated from its name alone: confirm
that the change does not affect gvproxy and, when attribution is needed, rerun the same test on the
base revision. Include the failure in the final report even when the local-volume evidence passes.

## 7. Check the final diff and report

Remove only temporary files created by the current test run. Leave pre-existing files and build
caches alone, then run:

```bash
git diff --check
git status --short --branch
```

Report each command with its platform and outcome. Include the number or names of tests executed,
not just the command's exit status. Use this compact format:

| Area | Command | Result | Evidence or limitation |
| --- | --- | --- | --- |
| Rust units | `make test:unit:rust` | Pass/fail | Test totals or failing test |
| Guest | `make test:unit:guest` | Pass/fail/not run | Linux result or platform blocker |
| CLI VM | `make test:integration:cli FILTER=local_volume` | Pass/fail/not run | Three named tests |
| CLI single-file VM | `make test:integration:cli FILTER=test_run_with_single_file_volume` | Pass/fail/not run | Required for mount protocol or guest bind dispatch changes |
| Python VM | Standard target or fallback | Pass/fail/not run | Interpreter and named test |

The runbook is complete when every applicable step has run, all intended tests are accounted for,
changed-code failures are fixed, and every skip, unrelated failure, or unrun platform check is
explicit in the report.
