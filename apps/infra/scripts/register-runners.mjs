// Pulumi stores this exact path in the RegisterExtraRunners command resource.
// Keep the launcher stable while the implementation lives in the Runner domain.
import 'tsx/esm'

await import('../runner/register.ts')
