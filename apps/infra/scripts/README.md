# Stable Pulumi launchers

Two launcher paths are persisted in Pulumi `command.local.Command` inputs:

- `register-runners.mjs` — referenced by `RegisterExtraRunners`.
- `runner-update-binary.mjs` — referenced by the `UpgradeRunnerBinary-*` resources.

Keep their command strings stable so an organizational refactor cannot re-run
Runner registration or binary upgrades. All implementation code lives in `runner/`.
