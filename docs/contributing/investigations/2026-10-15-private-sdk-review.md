## TL;DR

Preserve registry and cleanup contracts, and collect native SDK coverage from one
consistent build directory.

## Details

Scope: registry fixes and their regressions ship in #1956 under tracking issue #1948, so the registry SDK layer can merge independently. Estimated addition: 100–150 source lines including Rust inline tests, plus a Python regression and documentation. The stack keeps its existing PRs.

## Related work and lessons

- At 9d9574fa, `sdks/c/src/registries.rs:64-86` converts invalid C strings to NULL despite the non-null credential contract. Both create and list use this conversion. `event_queue.rs:274-342` already owns queued allocations, including undelivered events.
- Rust's CString documentation, sections Creating a CString and into_raw, requires rejecting interior NUL bytes and returning raw allocations through from_raw: https://doc.rust-lang.org/std/ffi/struct.CString.html#method.new. Adopt checked CString construction. Do not remove NUL bytes: that could change the ID later supplied to remove.
- `info.rs:169-178` frees a boxed slice and runs element destructors. Give registry values a destructor so failed list collection frees earlier entries. Build all CString fields before releasing their raw pointers, avoiding partial-construction leaks.
- The older generic alloc_c_string helper explicitly permits NULL. Image converters use that legacy convention without the registry's explicit non-null contract; changing those APIs is separate work.
- `apps/e2e/cases/test_images_private.py:135-163,251-263` already retries cleanup at fixture teardown, but popping the login before an awaited remove defeats that retry. Retain the record until success.
- The core `NewRegistryCredential` implements redacted Debug. Match that policy in Node with manual formatting that omits password and handle internals. This adds a diagnostic trait; it repairs no pre-existing password leak.

## How it works

Registry conversion returns Result. All required fields and a present created_by must form valid CStrings; otherwise return Internal with the field name, never field contents. Both list and create propagate that error through their existing callback path. RAII releases constructed entries if a later list entry fails.

The private-image E2E removal step reads the login ID, awaits deletion, and then removes the cleanup record. Add the Python example's missing imports. Add opaque Debug implementations to the two Node types.

## Validation

First run focused regressions with production unchanged. The C test calls the existing conversion through a test-only Result adapter and must observe invalid credentials accepted. The E2E regression runs the real removal step and teardown fixture against a failing remote boundary; it must observe that cleanup failed to retry. Then remove the adapter, implement the fixes, and rerun both.

Check valid and empty C strings, optional created_by, list partial-failure cleanup, and undelivered-event ownership. Run the C FFI unit suite and Rust formatting. Run Node unit checks for its diagnostic trait. Documentation must state the callback error and cleanup retention contracts.

## Observed verification

With production unchanged, the C regression accepted all five malformed fields;
the E2E regression recorded only the initial deletion, missing teardown's retry.
After the fix, both pass. The FFI suite passes with 105 tests and one skipped;
the Node binding suite passes with 35 tests. No live private registry or VM was
used for these focused regressions.

## Follow-up review: native coverage paths

The follow-up #1956 review identifies a separate coverage-path defect. Its fix
and orchestration regressions belong in #1956 alongside the collector they
exercise, together with the cleanup and Node Debug corrections. Later stack
layers retain tests for their own alias and routing changes.

### Evidence and alternatives

`scripts/test/coverage-bindings.sh` exports a caller-supplied `CARGO_TARGET_DIR`
before invoking Python and Node builds from their SDK directories. The report
command runs at the repository root. Cargo resolves environment-variable paths
against each command's working directory, per
[config-relative paths](https://doc.rust-lang.org/cargo/reference/config.html#config-relative-paths).
Consequently a relative override can put native objects outside the directory
the reporter scans.

The installed cargo-llvm-cov 0.9.1 `show-env --sh` makes
`CARGO_LLVM_COV_TARGET_DIR` absolute but does not replace `CARGO_TARGET_DIR`.
Relying on that command to normalize both values therefore leaves the defect.
Resolve relative overrides against the collector's repository root before
`show-env` and every SDK build. Preserve absolute overrides and the existing
default; concatenation avoids requiring the destination to exist or adding a
platform-specific canonicalization tool.

For the registry backend trait, check the lint before retaining an override. Rust's
[expect attribute](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-expect-attribute)
reports an obsolete suppression, matching the repository's Rust style guide.
Local Clippy 1.97.1 does not emit this macro-generated lint and rejects `expect`
as unfulfilled. CI uses Rust 1.99.1 and does emit it: removing the suppression
fails with three `clippy::double_must_use` errors. Use the requested `expect`
with its existing reason and validate with Clippy 1.99, matching CI's toolchain.
Normal builds retain the repository's existing Rust minimum version.

### Approach and validation

Estimated production addition: under 20 lines, excluding tests and meaningful
documentation. Add a standalone coverage-script unit suite and run it before
external coverage collection. Invoke the actual collector in an isolated tree
with stubbed build tools: builders resolve target paths from their SDK working
directories, and the reporter checks that their objects are present together.

First retain only the tests and observe the relative-path case fail because the
reporter cannot find Python and Node objects. The default and absolute-path cases
must pass. Restore the complete fix and rerun all cases, including a path with
spaces. Check shell syntax, ShellCheck when available, Rust formatting and the
registry expectation using a CI-compatible Clippy. Existing cleanup and
password-redaction regressions must continue to pass. These checks exercise orchestration, not a fresh native
coverage measurement or VM run.

### Follow-up verification

With every non-test file restored to `4e27dd8a`, the relative-path case failed
with missing Python and Node objects; the default and absolute-path cases passed.
Restoring the fix passed all three cases.

Bash syntax, ShellCheck, Python formatting/lint, Rust formatting, and the
cleanup-retry and credential-redaction regressions passed. The registry crate
passes Clippy 1.99.0 with the final expectation, matching CI's 1.99 diagnostic.
