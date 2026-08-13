// Pulumi stores this exact path in every UpgradeRunnerBinary command resource.
// Keep the launcher stable while the implementation lives in the Runner domain.
import 'tsx/esm'

const { runRunnerUpdateCli } = await import('../runner/update.ts')
runRunnerUpdateCli()
