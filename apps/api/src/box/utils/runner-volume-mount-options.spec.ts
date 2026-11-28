import {
  probeVolumeMountOptions,
  requiresVolumeMountOptions,
  VOLUME_MOUNT_OPTIONS_CAPABILITY,
} from './runner-volume-mount-options'

describe('volume mount option admission', () => {
  it('does not force legacy read-write subpaths onto mount-options-capable runners', () => {
    expect(
      requiresVolumeMountOptions([{ volumeId: 'volume-1', mountPath: '/data', subpath: 'team/backend' }] as any),
    ).toBe(false)
    expect(requiresVolumeMountOptions([{ volumeId: 'volume-1', mountPath: '/data', readOnly: true }] as any)).toBe(true)
    expect(requiresVolumeMountOptions(undefined)).toBe(false)
  })

  it('reports an explicit live capability answer', async () => {
    const runnerInfo = jest.fn().mockResolvedValue({ capabilities: [VOLUME_MOUNT_OPTIONS_CAPABILITY] })
    await expect(probeVolumeMountOptions({ runnerInfo }, 100)).resolves.toEqual({ status: 'supported' })
    expect(runnerInfo).toHaveBeenCalledWith(expect.any(AbortSignal))

    runnerInfo.mockResolvedValue({ capabilities: [] })
    await expect(probeVolumeMountOptions({ runnerInfo }, 100)).resolves.toEqual({ status: 'unsupported' })
  })

  it('bounds a hung runner probe as unavailable rather than unsupported', async () => {
    const runnerInfo = jest.fn((_signal?: AbortSignal) => new Promise(() => {}))
    const probe = await probeVolumeMountOptions({ runnerInfo }, 10)

    expect(probe.status).toBe('unavailable')
    if (probe.status !== 'unavailable') throw new Error('expected unavailable probe')
    expect(probe.error.message).toContain('timed out')
    expect(runnerInfo).toHaveBeenCalledWith(expect.any(AbortSignal))
  })
})
