import { boxVolumeForDispatch, boxVolumeForPublic } from './box-volume.util'

describe('box volume projections', () => {
  it('keeps readOnly in dispatch, not just in the Runner adapter', () => {
    const volume = {
      volumeId: 'volume-1',
      mountPath: '/data',
      subpath: 'team/backend',
      readOnly: true,
      filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
    } as any

    expect(boxVolumeForDispatch(volume)).toEqual({
      volumeId: 'volume-1',
      mountPath: '/data',
      subpath: 'team/backend',
      readOnly: true,
      filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
    })
  })

  it('keeps readOnly in a public response but hides Filestore connection details', () => {
    const volume = {
      volumeId: 'volume-1',
      mountPath: '/data',
      readOnly: true,
      filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
    } as any

    expect(boxVolumeForPublic(volume)).toEqual({
      volumeId: 'volume-1',
      mountPath: '/data',
      subpath: undefined,
      readOnly: true,
      filestore: { instance: 'ml-scratch' },
    })
  })
})
