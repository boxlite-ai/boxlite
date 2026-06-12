import { describe, expect, it } from 'vitest'
import { toBoxApiCreateRequest } from './cloudBox'

describe('toBoxApiCreateRequest', () => {
  it('converts dashboard GiB memory into Box API MiB', () => {
    const request = toBoxApiCreateRequest({ resources: { cpu: 2, memory: 4, disk: 10 } })

    expect(request.cpus).toBe(2)
    expect(request.memory_mib).toBe(4096)
    expect(request.disk_size_gb).toBe(10)
  })

  it('maps networkBlockAll onto the network mode and omits it otherwise', () => {
    expect(toBoxApiCreateRequest({ networkBlockAll: true }).network).toEqual({ mode: 'disabled' })
    expect(toBoxApiCreateRequest({ networkBlockAll: false }).network).toBeUndefined()
    expect(toBoxApiCreateRequest({}).network).toBeUndefined()
  })

  it('passes cloud-only fields through unchanged', () => {
    const request = toBoxApiCreateRequest({
      labels: { team: 'core' },
      public: true,
      autoStopInterval: 30,
      autoDeleteInterval: -1,
    })

    expect(request.labels).toEqual({ team: 'core' })
    expect(request.public).toBe(true)
    expect(request.auto_stop_interval).toBe(30)
    expect(request.auto_delete_interval).toBe(-1)
  })

  it('leaves memory undefined when no resources are given', () => {
    expect(toBoxApiCreateRequest({}).memory_mib).toBeUndefined()
    expect(toBoxApiCreateRequest().memory_mib).toBeUndefined()
  })
})
