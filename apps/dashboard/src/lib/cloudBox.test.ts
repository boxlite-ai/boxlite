import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/apiClient'
import { createBoxUploadDirectoryItem } from './box-upload'
import { toBoxApiCreateRequest, uploadBoxItemViaBoxApi } from './cloudBox'

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

  it('leaves memory undefined when no resources are given', () => {
    expect(toBoxApiCreateRequest({}).memory_mib).toBeUndefined()
    expect(toBoxApiCreateRequest().memory_mib).toBeUndefined()
  })

  it('uploads directory files under the returned directory path', async () => {
    const put = vi.fn().mockResolvedValue({})
    const api = { axiosInstance: { put } } as unknown as ApiClient
    const item = createBoxUploadDirectoryItem('project', [
      { file: new File(['console.log(1)'], 'index.ts'), relativePath: 'src/index.ts' },
      { file: new File(['# Project'], 'README.md'), relativePath: 'README.md' },
    ])

    const remotePath = await uploadBoxItemViaBoxApi(api, 'org-1', 'box-1', item, '/workspace')

    expect(remotePath).toBe('/workspace/project')
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls.map((call) => call[2]?.params?.path)).toEqual([
      '/workspace/project/src/index.ts',
      '/workspace/project/README.md',
    ])
  })
})
