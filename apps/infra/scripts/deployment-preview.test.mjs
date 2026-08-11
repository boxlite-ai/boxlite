// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateDeploymentPreview } from './deployment-preview.mjs'

const runnerChange = ({
  name = 'Runner',
  op = 'update',
  detailedDiff = { __provider: { diffKind: 'update', inputDiff: true } },
  oldInputs,
  newInputs,
  protect = true,
} = {}) => ({
  op,
  urn: `urn:pulumi:dev::boxlite::aws:ec2/instance:Instance::${name}`,
  type: 'aws:ec2/instance:Instance',
  old: { protect: true, ...(oldInputs ? { inputs: oldInputs } : {}) },
  new: { protect, ...(newInputs ? { inputs: newInputs } : {}) },
  detailedDiff,
})

const plainDelete = (name, type) => ({
  op: 'delete',
  urn: `urn:pulumi:dev::boxlite::${type}::${name}`,
  type,
  old: { protect: false },
  detailedDiff: {},
})

test('accepts provider and tag-only updates to protected Runner instances', () => {
  const preview = [
    {
      op: 'replace',
      urn: 'urn:pulumi:dev::boxlite::aws:ecs/service:Service::ApiService',
      type: 'aws:ecs/service:Service',
      old: { protect: false },
      new: { protect: false },
      detailedDiff: {},
    },
    runnerChange({
      detailedDiff: {
        __provider: { diffKind: 'update', inputDiff: true },
        'tags["boxlite:control-plane-runner-name"]': { diffKind: 'add', inputDiff: true },
        'tagsAll["boxlite:control-plane-runner-name"]': { diffKind: 'add', inputDiff: false },
      },
    }),
    runnerChange({ name: 'Runner-runner-2', detailedDiff: { tags: { diffKind: 'update', inputDiff: true } } }),
  ]

  assert.deepEqual(validateDeploymentPreview(JSON.stringify(preview)), {
    changeCount: 3,
    runnerUpdates: [
      {
        name: 'Runner',
        paths: [
          '__provider',
          'tags["boxlite:control-plane-runner-name"]',
          'tagsAll["boxlite:control-plane-runner-name"]',
        ],
      },
      { name: 'Runner-runner-2', paths: ['tags'] },
    ],
  })
})

test('rejects Runner creates even when they are protected', () => {
  const create = runnerChange({ name: 'Runner-runner-2', op: 'create' })

  assert.throws(() => validateDeploymentPreview(JSON.stringify([create])), /unsafe Runner deployment plan/)
  assert.throws(
    () => validateDeploymentPreview(JSON.stringify([{ ...create, new: { protect: false } }])),
    /unsafe Runner deployment plan/,
  )
})

test('allows only extra Runners to migrate in place to the exact selected-stage profile', () => {
  const migration = runnerChange({
    name: 'Runner-runner-2',
    detailedDiff: { iamInstanceProfile: { diffKind: 'update', inputDiff: true } },
    oldInputs: { iamInstanceProfile: 'boxlite-dev-legacy-runner-profile' },
    newInputs: { iamInstanceProfile: 'boxlite-dev-extra-runner-profile' },
  })

  assert.deepEqual(validateDeploymentPreview(JSON.stringify([migration]), { stage: 'dev' }), {
    changeCount: 1,
    runnerUpdates: [{ name: 'Runner-runner-2', paths: ['iamInstanceProfile'] }],
  })

  for (const rejected of [
    { ...migration, urn: migration.urn.replace('::Runner-runner-2', '::Runner') },
    { ...migration, new: { ...migration.new, inputs: { iamInstanceProfile: 'other-profile' } } },
    {
      ...migration,
      detailedDiff: {
        iamInstanceProfile: { diffKind: 'update', inputDiff: true },
        instanceType: { diffKind: 'update', inputDiff: true },
      },
      new: {
        ...migration.new,
        inputs: { iamInstanceProfile: 'boxlite-dev-extra-runner-profile', instanceType: 'c8i.4xlarge' },
      },
    },
  ]) {
    assert.throws(
      () => validateDeploymentPreview(JSON.stringify([rejected]), { stage: 'dev' }),
      /unsafe Runner deployment plan/,
    )
  }
  assert.throws(() => validateDeploymentPreview(JSON.stringify([migration]), { stage: '' }), /unsafe Runner/)
})

test('rejects disruptive or unexplained Runner operations', () => {
  const unsafeChanges = [
    runnerChange({ op: 'replace' }),
    runnerChange({ op: 'delete', protect: false }),
    runnerChange({ name: 'Runner-runner-2', op: 'create' }),
    { ...runnerChange({ op: 'replace' }), type: 'aws:ec2/launchTemplate:LaunchTemplate' },
    {
      ...runnerChange({ name: 'Canary', op: 'create' }),
      new: { protect: true, inputs: { tags: { Name: 'boxlite-runner-3' } } },
    },
    runnerChange({ detailedDiff: { instanceType: { diffKind: 'update', inputDiff: true } } }),
    runnerChange({ detailedDiff: {} }),
  ]

  for (const change of unsafeChanges) {
    assert.throws(() => validateDeploymentPreview(JSON.stringify([change])), /unsafe Runner deployment plan/)
  }
})

test('rejects the real unknown-container plain-delete shape outside an exact reviewed removal', () => {
  const omittedServiceChildren = [
    plainDelete('OtelCollectorListenerHTTP4318', 'aws:lb/listener:Listener'),
    plainDelete('ApiTargetApiHTTP3000', 'aws:lb/targetGroup:TargetGroup'),
    plainDelete('PgAdminLogGroupPgAdmin', 'aws:cloudwatch/logGroup:LogGroup'),
    plainDelete('ProxyImageProxy', 'docker-build:index:Image'),
  ]

  assert.throws(
    () => validateDeploymentPreview(JSON.stringify(omittedServiceChildren), { stage: 'dev' }),
    (error) => {
      assert.match(error.message, /unreviewed resource deletion/)
      for (const change of omittedServiceChildren) {
        assert.match(error.message, new RegExp(change.urn.slice(change.urn.lastIndexOf('::') + 2)))
      }
      return true
    },
  )
})

test('requires one-run operator approval before accepting a reviewed dev Commerce deletion', () => {
  const reviewed = plainDelete('CommerceService', 'aws:ecs/service:Service')

  assert.throws(
    () => validateDeploymentPreview(JSON.stringify([reviewed]), { stage: 'dev' }),
    /explicit.*approval|approval.*required/i,
  )
})

test('allows only the exact dev Commerce teardown and reports it separately', () => {
  const reviewed = plainDelete('CommerceService', 'aws:ecs/service:Service')

  assert.deepEqual(
    validateDeploymentPreview(JSON.stringify([reviewed]), {
      stage: 'dev',
      approveDevCommerceTeardown: true,
    }),
    {
      changeCount: 1,
      runnerUpdates: [],
      reviewedDeletes: [{ name: 'CommerceService', type: 'aws:ecs/service:Service' }],
    },
  )
  for (const rejected of [
    { ...reviewed, urn: reviewed.urn.replace('::CommerceService', '::CommerceServiceCopy') },
    { ...reviewed, type: 'aws:iam/role:Role' },
  ]) {
    assert.throws(
      () =>
        validateDeploymentPreview(JSON.stringify([rejected]), {
          stage: 'dev',
          approveDevCommerceTeardown: true,
        }),
      /unreviewed resource deletion/,
    )
  }
  assert.throws(
    () =>
      validateDeploymentPreview(JSON.stringify([reviewed]), {
        stage: 'prod',
        approveDevCommerceTeardown: true,
      }),
    /unreviewed resource deletion/,
  )
})

test('the CLI accepts only the exact one-run Commerce teardown approval flag', () => {
  const reviewed = JSON.stringify([plainDelete('CommerceService', 'aws:ecs/service:Service')])
  const script = fileURLToPath(new URL('./deployment-preview.mjs', import.meta.url))
  const options = { encoding: 'utf8', env: { ...process.env, SST_STAGE: 'dev' }, input: reviewed }

  const unapproved = spawnSync(process.execPath, [script], options)
  assert.notEqual(unapproved.status, 0)
  assert.match(unapproved.stderr, /requires explicit one-run approval/)

  const approved = spawnSync(process.execPath, [script, '--approve-dev-commerce-teardown'], options)
  assert.equal(approved.status, 0, approved.stderr)
  assert.match(approved.stdout, /explicitly reviewed dev Commerce deletion/)

  const unknown = spawnSync(process.execPath, [script, '--approve-dev-commerce-teardown=true'], options)
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /expected no arguments or exactly/)
})

test('allows replacement cleanup without treating it as an unreviewed plain delete', () => {
  const cleanup = { ...plainDelete('ApiTask', 'aws:ecs/taskDefinition:TaskDefinition'), op: 'delete-replaced' }

  assert.deepEqual(validateDeploymentPreview(JSON.stringify([cleanup]), { stage: 'dev' }), {
    changeCount: 1,
    runnerUpdates: [],
  })
})

test('reports the composed deployment safety gate instead of the old Runner-only claim', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./deployment-preview.mjs', import.meta.url))], {
    encoding: 'utf8',
    input: '[]',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /passed the deployment safety gate/)
  assert.doesNotMatch(result.stdout, /passed the Runner safety gate/)
})

test('rejects malformed SST diff output', () => {
  assert.throws(() => validateDeploymentPreview('not JSON'), /valid JSON/)
  assert.throws(() => validateDeploymentPreview('{}'), /JSON array/)
  assert.throws(() => validateDeploymentPreview('[{"op":"update"}]'), /valid resource change/)
})
