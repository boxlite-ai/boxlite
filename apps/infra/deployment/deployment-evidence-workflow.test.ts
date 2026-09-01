// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const infra = readFileSync(new URL('../../../.github/workflows/deploy-infra.yml', import.meta.url), 'utf8')
const release = readFileSync(new URL('../../../.github/workflows/deploy-release.yml', import.meta.url), 'utf8')

for (const [name, workflow] of [
  ['deploy-infra', infra],
  ['deploy-release', release],
] as const) {
  test(`${name} publishes evidence through a separate best-effort OIDC role`, () => {
    assert.match(workflow, /id: deployment-evidence-credentials/)
    assert.match(workflow, /boxlite-backoffice-\$\{\{ inputs\.stage \}\}-deployment-publisher/)
    assert.match(workflow, /unset-current-credentials: true/)
    assert.match(workflow, /continue-on-error: true/)
    assert.match(workflow, /steps\.deployment-evidence-credentials\.outcome == 'success'/)
    assert.match(workflow, /npx tsx deployment\/deployment-evidence\.ts/)
    assert.match(workflow, /boxlite-backoffice-\$\{\{ inputs\.stage \}\}-deployments/)
  })
}

test('deploy-infra emits only the selected API and Runner components using the resolved artifact commit', () => {
  assert.match(infra, /DEPLOYMENT_EVIDENCE_COMPONENTS:.*inputs\.components == 'api\+runner'/)
  assert.match(infra, /DEPLOYMENT_EVIDENCE_COMMIT_SHA: \$\{\{ needs\.resolve-ref\.outputs\.sha \}\}/)
  assert.match(infra, /DEPLOYMENT_EVIDENCE_WORKFLOW: deploy-infra/)
})

// DEPLOY_EXCLUDE only ever removes Api or Runner, so every deploy-infra run reconciles
// stack/edge.ts's Proxy and stack/observability.ts's OtelCollector from the selected
// commit. Omitting them leaves their recorded identity stale until the next release.
test('deploy-infra reports the components no narrowing can exclude', () => {
  const components = infra.match(/DEPLOYMENT_EVIDENCE_COMPONENTS: (.*)/)?.[1] ?? ''
  assert.match(components, /proxy/)
  assert.match(components, /otel-collector/)
})

test('deploy-release separates published artifact identity from checkout-built proxy identity', () => {
  assert.match(release, /git rev-list -n 1 "v\$VERSION"/)
  assert.match(release, /DEPLOYMENT_EVIDENCE_COMPONENTS: api,runner/)
  assert.match(release, /DEPLOYMENT_EVIDENCE_COMMIT_SHA: \$\{\{ env\.RELEASE_COMMIT_SHA \}\}/)
  assert.match(release, /DEPLOYMENT_EVIDENCE_COMPONENTS: proxy,otel-collector/)
  assert.match(release, /DEPLOYMENT_EVIDENCE_COMMIT_SHA: \$\{\{ github\.sha \}\}/)
})
