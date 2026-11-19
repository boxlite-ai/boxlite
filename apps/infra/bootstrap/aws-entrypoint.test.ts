import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('native AWS bootstrap rejects protected stages and legacy-only provisioning before provisioning', (t) => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const emptyPath = mkdtempSync(join(tmpdir(), 'bootstrap-no-cloud-cli-'))
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }))
  for (const [args, expected] of [
    [['--stage', 'prod'], /protected.*--confirm/],
    [['--stage', 'dev', '--provision-auth0'], /separately provisioned services/],
    [['--stage', 'dev', '--provision-ses'], /separately provisioned services/],
  ] as const) {
    const child = spawnSync(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', 'bootstrap/bootstrap.ts', ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          PATH: emptyPath,
          MSTAGE_CONFIG: join(cwd, '.mstage.config.example.json'),
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_ENDPOINT_URL: 'http://127.0.0.1:1',
        },
      },
    )
    assert.equal(child.status, 1, child.stderr)
    assert.match(child.stderr, expected)
  }
})
