/*
 * The plain Pulumi entrypoint must install every provider namespace before it
 * imports the shared stack. A missing namespace otherwise surfaces only when a
 * real apply reaches that provider, after earlier resources may already exist.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { installGlobals, type PulumiModules } from '../pulumi/program.ts'

test('the GCP Pulumi program installs the Kubernetes provider namespace', () => {
  const kubernetes = { core: {}, apps: {}, policy: {}, apiextensions: {} }
  const modules = {
    pulumi: {
      interpolate: Symbol('interpolate'),
      output: Symbol('output'),
      jsonStringify: Symbol('jsonStringify'),
      all: Symbol('all'),
      secret: Symbol('secret'),
    },
    gcp: {},
    random: {},
    cloudflare: {},
    command: {},
    kubernetes,
  } satisfies PulumiModules
  const target: Record<string, unknown> = {}

  installGlobals({ modules, app: 'boxlite', stage: 'gcp-dev', target })

  assert.equal(target.kubernetes, kubernetes)
  assert.deepEqual(target.$app, { name: 'boxlite', stage: 'gcp-dev' })
})
