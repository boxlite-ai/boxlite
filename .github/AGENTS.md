# GitHub Actions

Follow the [root instructions](../AGENTS.md). CI policy and implementation details
live in the [workflow guide](workflows/README.md).

## Changes

- Preserve documented check selection and quality/security gates unless the user
  requests a policy change.
- Before expanding triggers or matrices, explain the missing coverage and check
  whether existing actions or builds can serve it.

## Runs

- Check existing runs for the current commit. No empty commits or draft/Ready
  toggles to force CI, or dispatches solely to warm caches.
- Manual runs must serve the requested task. Inspect the workflow, ref, inputs,
  and downstream side effects before dispatching.
- Diagnose failures before retrying; target the affected job with
  `gh run rerun --job JOB_ID`. Diagnose again if it fails; no blind retry loops.

## Verification

- Workflow execution changes: run `make test:apps:infra` and applicable workflow
  linting locally. Markdown-only changes: check links and whitespace; no matrix dispatch.
- Performance comparisons: report summed job runner time separately from elapsed time.
