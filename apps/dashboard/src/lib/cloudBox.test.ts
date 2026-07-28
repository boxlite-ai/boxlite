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
      autoPauseIntervalSeconds: 1800,
      autoDelete: 604800,
    })

    expect(request.auto_pause).toBe(1800)
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
})

describe('validateLifecyclePolicy', () => {
  it('accepts disabled policies and a delete deadline after the pause deadline', () => {
    expect(validateLifecyclePolicy({ autoPauseIntervalSeconds: 0, autoDelete: 0 })).toBeNull()
    expect(validateLifecyclePolicy({ autoPauseIntervalSeconds: 900, autoDelete: 3600 })).toBeNull()
  })

  it('rejects invalid sentinels and delete deadlines that do not follow pause', () => {
    expect(validateLifecyclePolicy({ autoPauseIntervalSeconds: -1, autoDelete: 0 })).toMatch(
      /Auto-pause/,
    )
    expect(validateLifecyclePolicy({ autoPauseIntervalSeconds: 900, autoDelete: -1 })).toMatch(
      /Auto-delete/,
    )
    expect(validateLifecyclePolicy({ autoPauseIntervalSeconds: 900, autoDelete: 900 })).toMatch(
      /greater than/,
    )
  })
})
