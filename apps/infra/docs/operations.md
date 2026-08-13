# Infrastructure operations

Run commands from `apps/infra`:

```bash
npm run login
npm run bootstrap -- --stage dev
npm run sst -- diff --stage dev --policy policies/runner --json | npm run --silent validate-preview
npm run deploy -- --stage dev --policy policies/runner
npm run runner:update
```

`deploy`, `remove`, `sst`, and `secrets` all pass through the guarded deployment facade. Do not call
the SST binary directly. `runner:update` rolls one host at a time and stops on the first failure.

The two files under `scripts/` are logic-free compatibility launchers. Pulumi Command resources
retain those exact paths and command strings so reorganizing source does not trigger fleet actions.

For detailed environment setup, artifact modes, deployment scopes, cost notes, and troubleshooting,
see [the deployment runbook](deployment.md).
