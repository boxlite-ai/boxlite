import { RUNNER_FEATURES, requiredRunnerFeaturesForCapabilities, runnerSupportsFeatures } from './runner-features'

describe('runner feature negotiation', () => {
  it('requires every requested feature and treats old runners as unsupported', () => {
    expect(runnerSupportsFeatures(undefined, [RUNNER_FEATURES.LINUX_CAPABILITIES_V2])).toBe(false)
    expect(runnerSupportsFeatures([], [RUNNER_FEATURES.LINUX_CAPABILITIES_V2])).toBe(false)
    expect(runnerSupportsFeatures(['other'], [RUNNER_FEATURES.LINUX_CAPABILITIES_V2])).toBe(false)
    expect(
      runnerSupportsFeatures(
        [RUNNER_FEATURES.LINUX_CAPABILITIES_V2],
        [RUNNER_FEATURES.LINUX_CAPABILITIES_V2],
      ),
    ).toBe(true)
  })

  it('does not constrain ordinary boxes', () => {
    expect(runnerSupportsFeatures(undefined, undefined)).toBe(true)
    expect(runnerSupportsFeatures(undefined, [])).toBe(true)
  })

  it('derives the feature requirement from either capability list', () => {
    expect(requiredRunnerFeaturesForCapabilities(undefined)).toEqual([])
    expect(requiredRunnerFeaturesForCapabilities({ add: [], drop: [] })).toEqual([])
    expect(requiredRunnerFeaturesForCapabilities({ add: ['SYS_PTRACE'], drop: [] })).toEqual([
      RUNNER_FEATURES.LINUX_CAPABILITIES_V2,
    ])
    expect(requiredRunnerFeaturesForCapabilities({ add: [], drop: ['NET_RAW'] })).toEqual([
      RUNNER_FEATURES.LINUX_CAPABILITIES_V2,
    ])
  })
})
