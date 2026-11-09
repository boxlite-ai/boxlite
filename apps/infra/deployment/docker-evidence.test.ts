// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const steps = (loadYaml(readFileSync(join(REPO_ROOT, '.github/workflows/e2e-local.yml'), 'utf8')) as any).jobs['e2e-tests'].steps
const evidenceProducer = `
import argparse, asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'tests/docker'))
import acceptance
class FakeWorker:
    identity = {'hostname': 'acceptance-host', 'machine_id': 'acceptance-machine', 'host_os': 'Linux'}
    async def call(self, operation, **values):
        if operation == 'create':
            return {'box': 'box-1', 'worker': self.identity}
        return {'code': 0, 'stdout': 'task diagnostic', 'stderr': ''}
async def start(*args):
    return FakeWorker()
async def main():
    acceptance.RemoteWorker.start = start
    scene = acceptance.Scene(argparse.Namespace(output=Path(sys.argv[2]), download_proxy=None), 'single')
    worker = await scene.start('local', 'runner-a')
    await scene.create(worker)
    await scene.run(0, 'docker info')
    scene.passed('D3')
    log = scene.log.read_text()
    value = log.index('"machine_id": ') + len('"machine_id": ')
    (scene.output / 'interrupted.log').write_text(log[:log.index('"', value + 1)])
    assert worker.identity['machine_id'] == 'acceptance-machine'
asyncio.run(main())
`

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)])
}

for (const [route, uploadName, redactId] of [
  ['normal', 'Upload Docker and Swarm evidence', 'redact_current_evidence'],
  ['failure', 'Upload test logs on failure or cancellation', 'redact_current_evidence'],
  ['rescue', 'Upload rescued prior-run logs', 'redact_rescued_evidence'],
]) {
  test(`${route} evidence removes runner identities and retains diagnostics`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'docker-evidence-'))
    const expand = (value: string) => value.replace(/\$\{\{\s*github.run_id\s*\}\}/g, '123')
      .replace(/\$\{\{\s*github.run_attempt\s*\}\}/g, '2')
      .replaceAll('/var/log/boxlite-ci', join(scratch, 'logs')).replaceAll('/tmp/boxlite-rescue', join(scratch, 'rescue'))
      .replaceAll('/tmp/boxlite-*', join(scratch, 'boxlite-*')).replaceAll('target/nextest/', join(scratch, 'nextest/'))
    const execute = (script: string, env = {}) => spawnSync('bash', ['-eo', 'pipefail', '-c', expand(script)], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GH_RUN_ID: '123', GH_RUN_ATTEMPT: '2', ...env },
    })
    try {
      const output = join(scratch, 'logs', route === 'rescue' ? '122-1' : '123-2', 'docker')
      const produced = spawnSync(process.env.CONDA_PYTHON_EXE || 'python3', ['-c', evidenceProducer, REPO_ROOT, output], {
        encoding: 'utf8', timeout: 10_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
      assert.equal(produced.status, 0, produced.stderr)
      const before = files(output).map((path) => readFileSync(path, 'utf8')).join('\n')
      assert.match(before, /acceptance-host/)
      assert.match(before, /acceptance-machine/)
      if (route === 'rescue') {
        const staged = execute(steps.find((step: any) => step.name === 'Stage prior-run logs for rescue').run)
        assert.equal(staged.status, 0, staged.stderr)
      }
      const redaction = steps.find((step: any) => step.id === redactId)
      assert.ok(redaction, 'evidence must pass through redaction before upload')
      const redacted = execute(redaction.run, { EVIDENCE_ROOT: expand(redaction.env.EVIDENCE_ROOT) })
      assert.equal(redacted.status, 0, redacted.stderr)
      const upload = steps.find((step: any) => step.name === uploadName)
      assert.ok(steps.indexOf(redaction) < steps.indexOf(upload))
      const selected = upload.with.path.trim().split('\n').filter((path: string) => !path.startsWith('!'))
        .flatMap((path: string) => globSync(expand(path.trim())))
        .flatMap((path: string) => statSync(path).isDirectory() ? files(path) : [path])
      assert.ok(selected.length > 0)
      const published = selected.map((path: string) => readFileSync(path, 'utf8')).join('\n')
      assert.doesNotMatch(published, /acceptance-host|acceptance-machine/)
      assert.match(published, /task diagnostic/)
      assert.match(published, /"D3"/)
      assert.match(published, /"box": "box-1"/)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test(`${route} evidence is withheld if redaction fails`, () => {
    const upload = steps.find((step: any) => step.name === uploadName)
    const condition = (upload.if || 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    for (const outcome of ['success', 'failure']) {
      for (const cancelled of route === 'rescue' ? [false] : [false, true]) {
        const enabled = runInNewContext(condition, {
          always: () => true, success: () => true, failure: () => route === 'failure' && !cancelled, cancelled: () => cancelled,
          steps: { [redactId]: { outcome } },
        })
        assert.equal(enabled, outcome === 'success', `redaction outcome: ${outcome}; cancelled: ${cancelled}`)
      }
    }
  })
}
