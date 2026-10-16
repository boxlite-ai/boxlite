## TL;DR

Registry corrections and their regressions must ship with the registry SDK layer so each stack part can merge independently.

## Details

Scope: move existing registry SDK regressions, their required fixes, and native
coverage collector corrections from #1958 to #1956; restack #1957 and #1958.
Preserve the final stack's API and the 90% patch coverage requirement. Keep tests
for alias operations and nested registry routing with their implementation.
Estimated new production code: none; existing corrections change ownership
between PRs. Sequential merging requires each layer to test its own contract.

## Evidence and alternatives

At `ac2f8859`, Python and Node registry HTTP boundary tests already belong to
#1956, including Python's synchronous create/list/remove test. Their differences
at `b3db4489` adapt the nested registry API introduced in #1958; moving those
adaptations earlier would test an unavailable API.

However, the C malformed-string regression and cleanup retry correction in
`192f71e7`, Node credential-redaction test in `7b933898`, and native coverage
path regression in `d900a0d6` were placed in #1958. Their implementations belong
to #1956 and must move together. Registry deletion concurrency corrections
(`620eb8d2`, `bd00dde3`) concern the already-merged registry backend; #1956 is
the earliest remaining layer that can carry them and their PostgreSQL tests.

[Codecov status documentation](https://docs.codecov.com/docs/commit-status)
distinguishes patch coverage from project coverage. On the same #1956 commit,
the patch report changed from 50% to 80.08% while Rust jobs were still running.
Wait for native coverage uploads before treating an intermediate report as the
final result. Lowering the threshold or excluding bindings would hide the gap.

CodeQL alert 297 follows `null_mut -> wrapped_val -> dereference` in the
locked napi-derive-backend 5.0.4 class conversion, not a registry method body.
The generator unconditionally emits both reference conversions for classes:
[upstream source](https://github.com/napi-rs/napi-rs/blob/5ed87dd7e930961e9273f95cd0ed77c2da967bc1/crates/backend/src/codegen/struct.rs#L113).
[NAPI-RS class documentation](https://napi.rs/docs/concepts/class#choose-the-right-javascript-shape)
confirms that replacing the class with an object changes its JavaScript shape.
Changing method bodies or the stored Arc cannot repair the generated conversion.
Do not move the flagged code or disable analysis merely to hide the alert.

## Approach

Transplant complete existing fixes when independent, and only the registry
portion of mixed commits. Keep each regression beside the code it exercises.
Update documentation that previously directed registry fixes to the stack tip.
Replay the remaining stack and compare its final tree against the saved tip to
detect accidental lost behavior. Use existing branch leases when pushing.

## Validation

Run the moved script regressions, C conversion and Node redaction tests, and
the registry deletion suite with PostgreSQL. Existing recorded red/green runs
remain historical evidence, not fresh verification. Check every remaining
layer's diff for test dependencies and let its own CI recompute coverage.
Evaluate a CodeQL rewrite only if it preserves the class contract and actually
changes the unsafe conversion; otherwise report the dependency limitation.

## Observed verification

On the registry SDK layer, the moved C conversion/ownership tests (2), Node
credential-redaction test (1), collector tests (3), cleanup retry test (1), and
registry service/PostgreSQL concurrency tests (16) pass. Scoped API ESLint,
collector shell syntax, Rust formatting, and `make help` also pass. This is
focused verification; it does not replace the complete CI suites.

After the Linux native SDK upload completed, Codecov passed on `ac2f8859` with
91.96% patch coverage against the unchanged 90% target. The earlier failed
reports were incomplete. Reordering the stack triggers new checks on its new
commits; that historical pass is not a result for those commits.

The locked class generator offers no override for `FromNapiRef` or
`FromNapiMutRef`. Preserve the existing class instead of introducing a new
handwritten unsafe binding or changing its public shape to avoid the diagnostic.
A dependency-level correction or reviewed alert disposition is still needed.
