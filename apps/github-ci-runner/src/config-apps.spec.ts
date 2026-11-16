/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'
describe('standalone App registry configuration', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ci-apps-config-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  const entry = { client_id: 'personal', private_key_file: '/run/secrets/personal.pem' }
  const read = (value: unknown, extra: NodeJS.ProcessEnv = {}, mode = 0o600) => {
    const file = join(directory, 'apps.json')
    writeFileSync(file, JSON.stringify(value), { mode })
    return loadConfig({
      BOXLITE_REST_URL: 'https://box.test',
      BOXLITE_API_KEY: 'private-box-key',
      CI_GITHUB_APPS_FILE: file,
      ...extra,
    })
  }
  it('defaults self-owned Apps to both account types and keeps a single total capacity', () => {
    const config = read([entry, { ...entry, client_id: 'organization', account_type: 'Organization' }], {
      CI_WORKER_MAX: '3',
    })
    expect(config.github).toMatchObject({
      kind: 'app',
      issuer: 'personal',
      applications: [
        { issuer: 'personal', accountType: undefined },
        { issuer: 'organization', accountType: 'Organization' },
      ],
    })
    expect(config.max).toBe(3)
    expect(JSON.stringify(config)).not.toContain('private-box-key')
  })
  it.each(
    [
      [],
      Array(9).fill(entry),
      [entry, entry],
      [{ ...entry, account_type: 'Enterprise' }],
      [{ ...entry, private_key_file: 'relative.pem' }],
      [{ ...entry, unexpected: true }],
    ].map((value) => [value]),
  )('rejects invalid App arrays', (value) => {
    expect(() => read(value)).toThrow()
  })
  it('rejects public registry files and ambiguous single-App or token settings', () => {
    expect(() => read([entry], {}, 0o644)).toThrow('private')
    for (const extra of [
      { CI_GITHUB_APP_CLIENT_ID: 'single' },
      { GITHUB_TOKEN: 'private-token' },
      { CI_GITHUB_WEBHOOK_SECRET_FILE: '/run/secrets/hook' },
    ])
      expect(() => read([entry], extra)).toThrow('Choose an Apps file')
  })
})
