# Stable Pulumi launchers

Every launcher path here is persisted in a `command.local.Command` input, so its
command string has to stay stable: an organizational refactor that moved one
would re-run runner registration or a binary upgrade on every host.

Two deploy paths are live at once while mdeploy takes over from the incumbent
SST stack, and each records its own launchers. That is the reason for the pairs
rather than an oversight — a path's launcher is written into that path's state,
so neither can be repointed at the other's.

| launcher | resource | path |
|---|---|---|
| `register-runners.mjs` | `RegisterExtraRunners` | incumbent (`stack/`, `deployment/`) |
| `runner-update-binary.mjs` | `UpgradeRunnerBinary-*` | incumbent — implementation in `runner/update.ts` |
| `register-extra-runners.mjs` | `RegisterExtraRunners` | mdeploy — implementation in `mdeploy/src/` |
| `upgrade-runner-binary.mjs` | `UpgradeRunnerBinary*` | mdeploy — implementation in `mdeploy/src/` |

## Doing either by hand

`npm run runner:update` and `npm run runner:build` are mdeploy's, and are what to
reach for. Their incumbent counterparts are still installed as
`runner:update:legacy` and `runner:build-artifact:legacy`, for a fleet the
incumbent stack still owns; both are removed with the rest of that path once the
cutover is done.
