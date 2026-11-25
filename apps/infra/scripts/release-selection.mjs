// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const groups = {
  runtime: 'runtime-distribution',
  wheels: 'wheels-',
  node: 'node-packages',
  c: 'c-sdk-',
  go: '',
  runner: 'runner-linux-amd64',
}

export function selectRelease(command, buildOnly, candidate, source) {
  if (command === 'publish') {
    assert.ok(!candidate && !source, 'A full release requires its product tag')
    return { mode: buildOnly ? 'ghcr' : 'release', builds: buildOnly ? ['c', 'runner'] : Object.keys(groups), group: '', producer: '' }
  }
  const match = /^(publish|repair)-(runtime|wheels|node|c|go|runner)$/.exec(command)
  assert.ok(match, 'Unknown component command')
  const [, operation, component] = match
  const group = groups[component]
  if (operation === 'repair') {
    assert.ok(['runtime', 'wheels', 'node', 'c'].includes(component) && !buildOnly && !source && /^[1-9]\d*$/.test(candidate),
      'Repair requires a candidate ID, a supported component and build-only=false')
    return { mode: 'repair', builds: [], group, producer: '' }
  }
  assert.ok(!candidate && (buildOnly || !source), 'Only standalone builds accept a source ref')
  const builds = ['go', 'runner'].includes(component) ? ['c', component] : [component]
  const producer = component === 'runner' ? 'publish-runner' : 'build-' + component
  return { mode: buildOnly ? 'build' : 'component', builds, group, producer }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { COMMAND, BUILD_ONLY, CANDIDATE, SOURCE, GITHUB_OUTPUT } = process.env
  const selection = selectRelease(COMMAND, BUILD_ONLY === 'true', CANDIDATE, SOURCE)
  for (const [key, value] of Object.entries(selection))
    appendFileSync(GITHUB_OUTPUT, key + '=' + (Array.isArray(value) ? JSON.stringify(value) : value) + '\n')
}
