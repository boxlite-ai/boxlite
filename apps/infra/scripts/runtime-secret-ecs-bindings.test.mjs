// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { RuntimeSecretEcsBindings } from './runtime-secret-ecs-bindings.mjs'

pulumi.runtime.setMocks(
  {
    call: (args) => args.inputs,
    newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }),
  },
  'boxlite',
  'preview',
  true,
)

test('keeps ECS secret ARNs known while task ordering waits for the initial version', async () => {
  const stableArn = 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:synthetic'
  const initialVersion = new aws.secretsmanager.SecretVersion('SyntheticInitialVersion', {
    secretId: stableArn,
    secretString: pulumi.secret('synthetic-only'),
  })
  const bindings = new RuntimeSecretEcsBindings({
    definitions: [
      {
        id: 'synthetic',
        consumers: [{ component: 'Api', environmentKey: 'SYNTHETIC_SECRET' }],
      },
    ],
    initialVersions: { synthetic: initialVersion },
    secrets: { synthetic: { arn: stableArn } },
  })

  assert.equal(await initialVersion.versionId.isKnown, false, 'a new provider-assigned version id must be unknown')

  const legacyArn = pulumi
    .all([bindings.arn('synthetic'), initialVersion.versionId])
    .apply(([arn]) => arn)
  assert.equal(await legacyArn.isKnown, false, 'joining the version id must reproduce the unknown-container bug')

  let normalizedContainerCount = 0
  const normalizedSecretArn = pulumi
    .output([{ ssm: { SYNTHETIC_SECRET: bindings.arn('synthetic') } }])
    .apply((containers) => {
      normalizedContainerCount += 1
      return containers[0].ssm.SYNTHETIC_SECRET
    })
  assert.equal(await normalizedSecretArn.isKnown, true)
  assert.equal(await normalizedSecretArn.promise(), stableArn)
  assert.equal(normalizedContainerCount, 1, 'SST-style container normalization must execute during preview')

  const dependencies = bindings.initialVersionsFor('Api')
  assert.deepEqual(dependencies, [initialVersion])
  assert.throws(() => bindings.initialVersionsFor('Typo'), /unknown runtime secret consumer component/)
})
