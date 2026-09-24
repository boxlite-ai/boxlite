## TL;DR

Keep launcher paths stable because deployment state stores their command strings.

# Stable Pulumi launchers

[Infrastructure index](../README.md) · [Runner operations](../docs/runners.md) · [mdeploy](../mdeploy/README.md)

These entrypoints appear in `command.local.Command` inputs. Moving or repointing one can rerun
registration or binary updates when the engine compares its saved command with the new declaration.
The repository retains both deployment trees; their presence is not evidence that both are live.

| Launcher | Resource | Owner |
| --- | --- | --- |
| `register-runners.mjs` | `RegisterExtraRunners` | Legacy `stack/` and `deployment/` |
| `runner-update-binary.mjs` | `UpgradeRunnerBinary-*` | Legacy implementation in `runner/update.ts` |
| `register-extra-runners.mjs` | `RegisterExtraRunners` | mdeploy implementation in `mdeploy/src/` |
| `upgrade-runner-binary.mjs` | `UpgradeRunnerBinary*` | mdeploy's command-based update path |

GCP mdeploy now declares an OS Config runner policy; a retained SSH helper does not mean it is the
normal fleet update path. Inspect the provider resource using a launcher before changing it.

For operator tasks, use `npm run runner:build`, `runner:promote`, and `runner:update` as documented
in the runner runbook. `runner:update:legacy` and `runner:build-artifact:legacy` belong to the
legacy deployment. Do not exchange their state-owned launchers during a documentation refactor.
