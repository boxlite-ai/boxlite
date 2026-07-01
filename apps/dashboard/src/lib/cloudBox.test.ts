// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createBoxUploadDirectoryItem } from './box-upload'
import { toBoxApiCreateRequest, uploadBoxItemViaBoxApi, uploadFileToBoxViaBoxApi } from './cloudBox'

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
})

describe('uploadFileToBoxViaBoxApi', () => {
  it('sends a tar archive to the box files endpoint with the workspace path', async () => {
    const put = vi.fn().mockResolvedValue({ data: undefined })
    const api = { axiosInstance: { put } } as never
    const file = new File(['payload'], 'test.zip', { type: 'application/zip' })

    await expect(uploadFileToBoxViaBoxApi(api, 'org-1', 'box-1', file, '/workspace')).resolves.toBe(
      '/workspace/test.zip',
    )

    expect(put).toHaveBeenCalledWith('v1/org-1/boxes/box-1/files', expect.any(Blob), {
      headers: { 'Content-Type': 'application/x-tar' },
      params: { path: '/workspace/test.zip' },
    })
  })

  it('uploads a directory item to a workspace folder path', async () => {
    const put = vi.fn().mockResolvedValue({ data: undefined })
    const api = { axiosInstance: { put } } as never
    const item = createBoxUploadDirectoryItem('project', [
      { file: new File(['payload'], 'index.ts'), relativePath: 'src/index.ts' },
    ])

    await expect(uploadBoxItemViaBoxApi(api, 'org-1', 'box-1', item, '/workspace')).resolves.toBe('/workspace/project')

    expect(put).toHaveBeenCalledWith('v1/org-1/boxes/box-1/files', expect.any(Blob), {
      headers: { 'Content-Type': 'application/x-tar' },
      params: { path: '/workspace/project' },
    })
  })
})
