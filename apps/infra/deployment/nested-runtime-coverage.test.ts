// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow: any = loadYaml(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'))
const steps = workflow.jobs.go.steps
const qualify = steps.find((step: any) => step.id === 'nested-runtime-coverage')
const modules = ['go-sdk', 'gvproxy', 'runner', 'image-service']

test('nested metadata qualification runs after full coverage and only on Linux x64', () => {
  assert.ok(qualify)
  assert.ok(steps.indexOf(qualify) > steps.findIndex((step: any) => step.run === 'make coverage:go'))
  assert.ok(steps.indexOf(qualify) < steps.findIndex((step: any) => step.uses?.startsWith('codecov/codecov-action@')))
  for (const target of ['linux-x64-gnu', 'linux-arm64-gnu', 'darwin-arm64']) {
    assert.equal(runInNewContext(qualify.if, { matrix: { platform: { target } } }, { timeout: 1000 }), target === 'linux-x64-gnu')
  }
})

for (const [name, available, focusedMode, fullMode] of [
  ['preserves both successful passes', true, 'atomic', 'atomic'],
  ['fails when KVM is unavailable', false, 'atomic', 'atomic'],
  ['rejects a non-atomic focused profile', true, 'set', 'atomic'],
  ['rejects a non-atomic full profile', true, 'atomic', 'count'],
] as const) {
  test(`nested metadata coverage ${name}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-nested-coverage-'))
    try {
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      mkdirSync(join(directory, 'target/coverage'), { recursive: true })
      for (const module of modules) {
        writeFileSync(join(directory, `target/coverage/${module}.out`), `mode: ${fullMode}\nexample/${module}/source.go:1.1,1.2 1 3\n`)
      }
      writeFileSync(join(bin, 'sudo'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > sudo.log\n', { mode: 0o755 })
      writeFileSync(join(bin, 'make'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> make.log
if [[ "$1" == '_ensure-kvm' ]]; then
  [[ "$NESTED_TEST_KVM_AVAILABLE" == 'true' ]]
  exit
fi
[[ "$1" == 'coverage:go' ]]
[[ "$2" == 'GOTEST_FILTER=-count=1 -run NestedVirtualization' ]]
[[ "$BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS" == '1' ]]
for module in go-sdk gvproxy runner image-service; do
  printf 'mode: %s\\nexample/%s/source.go:2.1,2.2 1 5\\n' "$NESTED_TEST_FOCUSED_MODE" "$module" > "target/coverage/$module.out"
done
`, { mode: 0o755 })
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', qualify.run], {
        cwd: directory,
        env: { ...process.env, ...qualify.env, PATH: `${bin}:${process.env.PATH}`, NESTED_TEST_KVM_AVAILABLE: String(available), NESTED_TEST_FOCUSED_MODE: focusedMode },
        encoding: 'utf8', timeout: 10_000,
      })
      assert.equal(result.error, undefined)
      const succeeds = available && focusedMode === 'atomic' && fullMode === 'atomic'
      assert.equal(result.status === 0, succeeds, result.stderr)
      assert.equal(readFileSync(join(directory, 'sudo.log'), 'utf8'), 'chmod a+rw /dev/kvm\n')
      const calls = readFileSync(join(directory, 'make.log'), 'utf8')
      assert.equal(calls.includes('coverage:go'), available)
      for (const module of modules) {
        const original = `mode: ${fullMode}\nexample/${module}/source.go:1.1,1.2 1 3\n`
        assert.equal(readFileSync(join(directory, `target/coverage/full-go/${module}.out`), 'utf8'), original)
        if (succeeds) {
          assert.equal(readFileSync(join(directory, `target/coverage/${module}.out`), 'utf8'),
            `mode: atomic\nexample/${module}/source.go:2.1,2.2 1 5\nexample/${module}/source.go:1.1,1.2 1 3\n`)
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
