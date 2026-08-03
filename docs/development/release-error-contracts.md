# Release Error Contracts

Run this check against the release candidate before publishing:

```bash
make test:e2e:error-contracts
```

The validation host must have the CLI, Python and Node SDKs, Go toolchain, C
compiler, and `libboxlite` built from the candidate commit. Treat a skipped SDK
case as incomplete validation.

The matrix must prove:

| Surface | Failure | Required result |
| --- | --- | --- |
| API and Python | Unknown image during create | 4xx typed error that mentions the image, snapshot, pull, or not-found cause |
| API | Invalid or excessive resources | Actionable 4xx response; never a raw 500 |
| CLI | Missing command | Non-zero exit with readable stderr |
| CLI | Command exits non-zero | Preserve the command exit code |
| Node and Go | Unknown image and missing box | Typed/caught error; never an internal 500 |
| C | Unknown image | Non-`Ok` structured error code and message |

Timeout behavior is additionally covered by
`scripts/test/e2e/cases/test_exec_timeout.py`. Enable it in the deployed-dev
workflow whenever the candidate runner and guest both carry the timeout
protocol; otherwise record the missing rollout as a release blocker.

Do not weaken a failing assertion or add an expected-failure marker during
release validation. File a focused follow-up for the owning layer and link it
from the release notes.
