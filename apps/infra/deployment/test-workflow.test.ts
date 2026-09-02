// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load as loadYaml } from 'js-yaml'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const TEST_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/test.yml')

test('API contract checkout preserves the fork PR secret boundary', () => {
  const workflow: any = loadYaml(readFileSync(TEST_WORKFLOW, 'utf8'))
  const steps: any[] = workflow.jobs.api.steps
  const checkout = steps.find((step) => step.name === 'Checkout Commerce contract provider')

  assert.ok(checkout, 'API tests no longer check out the Commerce contract provider')
  assert.equal(checkout.id, 'commerce_checkout')
  assert.match(String(checkout.if), /github\.event_name != 'pull_request'/)
  assert.match(String(checkout.if), /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(String(checkout.if), /github\.actor != 'dependabot\[bot\]'/)
  assert.equal(checkout.with.token, '${{ secrets.GH_PAT }}')
  assert.equal(checkout.with['persist-credentials'], '${{ false }}')

  const install = steps.find((step) => step.name === 'Install Commerce contract dependencies')
  assert.equal(install.if, "steps.commerce_checkout.outcome == 'success'")

  const apiTests = steps.find((step) => step.name === 'Run API unit tests')
  assert.equal(
    apiTests.env.BOXLITE_COMMERCE_REPOSITORY,
    "${{ steps.commerce_checkout.outcome == 'success' && format('{0}/.contract/boxlite-commerce', github.workspace) || '' }}",
  )
})
