import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

test('API-only releases skip Runner attachments while every selection still requires a published release', () => {
  const workflow = load(
    readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8'),
  ) as any
  const gate = workflow.jobs.resolve.steps.find((step: any) => step.name === 'Require the release this tag names')
  const directory = mkdtempSync(join(tmpdir(), 'mdeploy-release-scope-'))
  try {
    const gh = join(directory, 'gh')
    writeFileSync(gh, '#!/bin/bash\nprintf "%s" "$RELEASE"\nexit "${GH_STATUS:-0}"\n')
    chmodSync(gh, 0o755)
    const run = (components: string, draft: boolean, attached: boolean, status = 0) =>
      spawnSync('bash', ['-c', gate.run], {
        encoding: 'utf8',
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          VERSION: 'v1.2.3',
          COMPONENTS: components,
          GITHUB_REPOSITORY: 'example/fixture',
          GH_STATUS: String(status),
          RELEASE: JSON.stringify({
            isDraft: draft,
            assets: attached
              ? [
                  { name: 'boxlite-runner-v1.2.3-linux-amd64.tar.gz' },
                  { name: 'boxlite-runner-v1.2.3-linux-amd64.tar.gz.sha256' },
                ]
              : [],
          }),
        },
      })
    for (const component of ['api', 'runner', 'api+runner']) {
      assert.equal(run(component, false, true).status, 0)
      assert.notEqual(run(component, true, true).status, 0, `${component} admitted a draft`)
      assert.notEqual(run(component, false, true, 1).status, 0, `${component} admitted a missing release`)
      const missingAssets = run(component, false, false)
      if (component === 'api') assert.equal(missingAssets.status, 0, missingAssets.stdout)
      else {
        assert.notEqual(missingAssets.status, 0)
        assert.match(missingAssets.stdout, /carries no boxlite-runner/)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
