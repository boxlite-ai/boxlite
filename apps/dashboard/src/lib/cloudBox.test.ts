import { describe, expect, it } from 'vitest'
import { toBoxApiCreateRequest, validateLifecyclePolicy } from './cloudBox'

describe('toBoxApiCreateRequest', () => {
  it('converts dashboard GiB memory into Box API MiB', () => {
    const request = toBoxApiCreateRequest({ resources: { cpu: 2, memory: 4, disk: 10 } })

    expect(request.cpus).toBe(2)
    expect(request.memory_mib).toBe(4096)
    expect(request.disk_size_gb).toBe(10)
  })

  it('passes only supported cloud create fields through unchanged', () => {
    const request = toBoxApiCreateRequest({
      name: 'data-loader',
      image: 'python:3.12',
      user: '1000:1000',
      envVars: { PYTHONPATH: '/app' },
      network: { mode: 'enabled', allow_net: ['api.openai.com'] },
    })

    expect(request).toMatchObject({
      name: 'data-loader',
      image: 'python:3.12',
      user: '1000:1000',
      env: { PYTHONPATH: '/app' },
      network: { mode: 'enabled', allow_net: ['api.openai.com'] },
    })
    expect(request).not.toHaveProperty('public')
  })

  it('maps lifecycle seconds to the Box API wire fields', () => {
    const request = toBoxApiCreateRequest({
      autoStopIntervalSeconds: 1800,
      autoDelete: 604800,
    })

    expect(request.auto_stop).toBe(1800)
    expect(request.auto_delete).toBe(604800)
    expect(request.auto_resume).toBe(true)
  })

  it('maps auto-resume enabled to the Box API wire field', () => {
    const enabledRequest = toBoxApiCreateRequest({ autoResume: true })
    expect(enabledRequest.auto_resume).toBe(true)

    const disabledRequest = toBoxApiCreateRequest({ autoResume: false })
    expect(disabledRequest.auto_resume).toBe(false)
  })

  it('leaves memory undefined when no resources are given', () => {
    expect(toBoxApiCreateRequest({}).memory_mib).toBeUndefined()
    expect(toBoxApiCreateRequest().memory_mib).toBeUndefined()
  })

  // The REST boundary takes {managed_volume, guest_path} — NOT the internal
  // {volumeId, mountPath} pair it maps onto. Both fields are required, so
  // sending the internal shape is a 400, not a silent no-op.
  it('maps volume mounts to the REST managed_volume shape', () => {
    const request = toBoxApiCreateRequest({
      volumes: [
        { volumeId: 'vol-a1b2c3d4', mountPath: '/models' },
        // Names are accepted too: the API resolves id-or-name.
        { volumeId: 'customer-data', mountPath: '/data' },
      ],
    })

    expect(request.volumes).toEqual([
      { managed_volume: 'vol-a1b2c3d4', guest_path: '/models' },
      { managed_volume: 'customer-data', guest_path: '/data' },
    ])
  })

  it('omits volumes entirely when none are mounted', () => {
    expect(toBoxApiCreateRequest({ volumes: [] }).volumes).toBeUndefined()
    expect(toBoxApiCreateRequest({}).volumes).toBeUndefined()
  })
})

describe('validateLifecyclePolicy', () => {
  it('accepts disabled policies and a delete deadline after the stop deadline', () => {
    expect(validateLifecyclePolicy({ autoStopIntervalSeconds: 0, autoDelete: 0 })).toBeNull()
    expect(validateLifecyclePolicy({ autoStopIntervalSeconds: 900, autoDelete: 3600 })).toBeNull()
  })

  it('rejects invalid sentinels and delete deadlines that do not follow stop', () => {
    expect(validateLifecyclePolicy({ autoStopIntervalSeconds: -1, autoDelete: 0 })).toMatch(/Auto-stop/)
    expect(validateLifecyclePolicy({ autoStopIntervalSeconds: 900, autoDelete: -1 })).toMatch(/Auto-delete/)
    expect(validateLifecyclePolicy({ autoStopIntervalSeconds: 900, autoDelete: 900 })).toMatch(/greater than/)
  })
})
