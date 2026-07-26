import { LinuxCapabilities } from '../common/box-advanced-options'

export const RUNNER_FEATURES = {
  LINUX_CAPABILITIES_V2: 'linux-capabilities-v2',
} as const

export function requiredRunnerFeaturesForCapabilities(
  capabilities: Pick<LinuxCapabilities, 'add' | 'drop'> | null | undefined,
): string[] {
  return capabilities?.add.length || capabilities?.drop.length ? [RUNNER_FEATURES.LINUX_CAPABILITIES_V2] : []
}

export function runnerSupportsFeatures(
  advertised: readonly string[] | null | undefined,
  required: readonly string[] | null | undefined,
): boolean {
  if (!required?.length) {
    return true
  }
  const available = new Set(advertised ?? [])
  return required.every((feature) => available.has(feature))
}
