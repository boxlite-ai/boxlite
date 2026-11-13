import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/apiClient'
import { requestSsh, sshConnectionInstructions } from './ssh'

describe('SSH REST boundary', () => {
  it('rejects incomplete status instead of reporting SSH disabled', async () => {
    const api = { axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }) } } as unknown as ApiClient
    await expect(requestSsh(api, 'org', 'box', 'status')).rejects.toThrow('Invalid SSH status')
  })
})

describe('SSH connection instructions', () => {
  it.each(['box-1', 'Box_123'])('uses short commands for box ID %s', (boxId) => {
    expect(sshConnectionInstructions(boxId)).toEqual({
      login: 'boxlite auth login',
      connect: `boxlite ssh ${boxId}`,
    })
  })

  it.each(['', '-box', '$(id)', 'box;id', 'box name', "box'1", 'box/1', 'box\n', 'box\r', 'box\t', 'box\0', 'box\x7f', '盒子'])(
    'rejects unsafe box ID %j',
    (boxId) => {
      expect(() => sshConnectionInstructions(boxId)).toThrow('Invalid box ID')
    },
  )
})
