import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pulumiCheckpointKey } from '../src/environment/pulumi-state.ts'

test('the installed Pulumi CLI initializes the project-scoped checkpoint path mstage reads', (t) => {
  const version = spawnSync('pulumi', ['version'], { encoding: 'utf8', timeout: 10_000 })
  if ((version.error as NodeJS.ErrnoException)?.code === 'ENOENT') {
    t.skip('Pulumi CLI is not installed; SDK and backend tests remain available')
    return
  }
  assert.equal(version.status, 0, version.stderr)
  const root = mkdtempSync(join(tmpdir(), 'boxlite-pulumi-layout-'))
  try {
    const project = join(root, 'project'),
      backend = join(root, 'backend')
    mkdirSync(project)
    mkdirSync(backend)
    writeFileSync(join(project, 'Pulumi.yaml'), 'name: fixture-app\nruntime: yaml\n')
    const initialized = spawnSync(
      'pulumi',
      [
        'stack',
        'init',
        'organization/fixture-app/dev',
        '--cwd',
        project,
        '--non-interactive',
        '--secrets-provider',
        'passphrase',
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PULUMI_HOME: join(root, 'home'),
          PULUMI_BACKEND_URL: 'file://' + backend,
          PULUMI_CONFIG_PASSPHRASE: 'local-layout-test-only',
          PULUMI_SKIP_UPDATE_CHECK: 'true',
        },
      },
    )
    assert.equal(initialized.status, 0, initialized.stderr)
    const checkpoint = JSON.parse(readFileSync(join(backend, pulumiCheckpointKey('fixture-app', 'dev')), 'utf8'))
    assert.equal(checkpoint.version, 3)
    assert.equal(typeof checkpoint.checkpoint.stack, 'string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
