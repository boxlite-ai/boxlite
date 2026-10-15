## TL;DR

Reject unrepresentable registry responses before C callbacks report success, and retain E2E cleanup records until deletion succeeds.

## Details

Scope: the new review on #1956, integrated at the existing stack tip #1958 under tracking issue #1948. Estimated addition: 100–150 source lines including Rust inline tests, plus a Python regression and documentation. The stack remains six parts.

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
