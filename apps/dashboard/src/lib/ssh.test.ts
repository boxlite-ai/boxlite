import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/apiClient'
import { requestSsh, sshConnectionInstructions } from './ssh'

afterEach(() => vi.unstubAllGlobals())

describe('SSH REST boundary', () => {
  it('rejects incomplete status instead of reporting SSH disabled', async () => {
    const api = { axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }) } } as unknown as ApiClient
    await expect(requestSsh(api, 'org', 'box', 'status')).rejects.toThrow('Invalid SSH status')
  })
})

describe('SSH connection instructions', () => {
  it.each([
    { endpoint: 'https://api.example.test', organization: 'org-1' },
    { endpoint: 'https://api.example.test/team%20one', organization: `org'; printf injected; #` },
    { endpoint: "https://api.example.test/team'one", organization: '' },
  ])(
    'preserves endpoint and organization through the shell for $endpoint / $organization',
    ({ endpoint, organization }) => {
      vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
      const commands = sshConnectionInstructions(endpoint, organization, 'box-1')
      const directory = mkdtempSync(join(tmpdir(), 'boxlite-ssh-context-test-'))
      try {
        writeFileSync(
          join(directory, 'boxlite'),
          `#!/usr/bin/env node
console.log(JSON.stringify({
  url: process.env.BOXLITE_REST_URL ?? null,
  apiKey: process.env.BOXLITE_API_KEY ?? null,
  args: process.argv.slice(2),
}));
`,
          { mode: 0o700 },
        )
        const result = spawnSync('/bin/sh', ['-ec', `${commands.login}\n${commands.connect}`], {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            BOXLITE_REST_URL: 'https://unrelated.example.test',
            BOXLITE_API_KEY: 'unrelated-key',
            BOXLITE_CONTEXT: 'unrelated-context',
            BOXLITE_PROFILE: 'legacy-context',
          },
          encoding: 'utf8',
          timeout: 5000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(
          result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual([
          {
            url: null,
            apiKey: null,
            args: ['--context', `dashboard:${endpoint}`, 'auth', 'login', '--url', endpoint, '--method', 'api-key'],
          },
          {
            url: null,
            apiKey: null,
            args: ['--context', `dashboard:${endpoint}`, `--path-prefix=${organization}`, 'ssh', '--', 'box-1'],
          },
        ])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('normalizes relative endpoints without changing context across login and connection', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    expect(sshConnectionInstructions('/api/', 'org', 'box-1')).toEqual(
      sshConnectionInstructions('http://localhost:3000/api', 'org', 'box-1'),
    )
  })

  it('refuses control characters, unsafe box IDs, and credential-bearing URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    expect(() => sshConnectionInstructions('/api', 'org\n1', 'box-1')).toThrow()
    expect(() => sshConnectionInstructions('/api', 'org', '$(id)')).toThrow()
    expect(() => sshConnectionInstructions('https://secret@example.test', 'org', 'box-1')).toThrow()
    expect(() => sshConnectionInstructions('javascript:alert(1)', 'org', 'box-1')).toThrow()
  })
})
