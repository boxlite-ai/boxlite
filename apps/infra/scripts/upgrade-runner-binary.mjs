// The engine stores this exact path in every UpgradeRunnerBinary command
// resource, so keep the launcher stable while the implementation moves.
//
// A sibling of scripts/runner-update-binary.mjs rather than a change to it:
// that one launches the legacy SST stack's roll (apps/infra/runner/update.ts),
// which resolves its own artifact from the checkout and reaches AWS only. This
// one runs the payload mdeploy's stack rendered, on either cloud.
import 'tsx/esm'

const { runUpgradeRunnerCli } = await import('../mdeploy/src/upgrade-runners.ts')
runUpgradeRunnerCli()
