// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { load as loadYaml } from 'js-yaml'

const require = createRequire(import.meta.url)
const picomatch: (patterns: string[]) => (path: string) => boolean = require('picomatch')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const yaml = (path: string): any => loadYaml(readFileSync(join(root, path), 'utf8'))
const action = (name: string) => yaml(`.github/actions/${name}/action.yml`)
const goJob = () => yaml('.github/workflows/test.yml').jobs.go
const moduleCache = () => action('setup-go').runs.steps.find((step: any) => step.uses?.startsWith('actions/cache@'))
const evaluate = (value: string, context: any): string => value.replace(/\$\{\{\s*(.*?)\s*\}\}/g,
  (_match, expression: string) => String(runInNewContext(
    expression.replace(/inputs\.([\w-]+)/g, 'inputs["$1"]'), context)))

test('Go caching includes the actual monorepo module inputs, including the SDK without go.sum', () => {
  const setup = action('setup-go').runs.steps.find((step: any) => step.uses?.startsWith('actions/setup-go@'))
  const key = moduleCache()?.with.key
  const hashArguments = key?.match(/hashFiles\((.*?)\)/)?.[1]
  const patterns = hashArguments
    ? Array.from(hashArguments.matchAll(/'([^']+)'/g), (match: any) => match[1]) as string[]
    : String(setup.with['cache-dependency-path'] ?? 'go.sum').trim().split(/\s+/)
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  const dependencies = files.filter((file) => /(^|\/)go\.(mod|sum)$/.test(file))
  const matched = dependencies.filter(picomatch(patterns))
  assert.ok(matched.length > 0, 'Go cache restore must find dependency files; the repository has no root go.sum')
  assert.ok(matched.includes('sdks/go/go.mod'), 'the SDK has no go.sum, so its go.mod must participate')
  for (const path of dependencies) assert.ok(matched.includes(path), `Go cache misses module input ${path}`)
})

test('Go builds never restore compiled CGO packages or cached test results', () => {
  const upstream = action('setup-go').runs.steps.find((step: any) => step.uses?.startsWith('actions/setup-go@'))
  assert.equal(String(upstream.with?.cache ?? 'true'), 'false',
    'setup-go caches GOCACHE, which cannot detect a changed external libboxlite.a')
})

test('Go formatting skips module caching while compilation jobs keep it', () => {
  const manifest = action('setup-go')
  const cache = moduleCache()
  const metadata = manifest.runs.steps.find((step: any) => step.id === 'modules')
  assert.ok(cache && metadata, 'module-only caching must be available')
  for (const [file, job, expected] of [
    ['lint.yml', 'go', 'false'],
    ['test.yml', 'go', 'true'],
    ['build-go.yml', 'test', 'true'],
    ['build-runner-binary.yml', 'build', 'true'],
  ]) {
    const caller = yaml(`.github/workflows/${file}`).jobs[job].steps.find((step: any) => step.uses === './.github/actions/setup-go')
    const inputs = { cache: String(caller.with?.cache ?? manifest.inputs.cache?.default ?? 'true') }
    assert.equal(evaluate(cache.if, { inputs }), expected, `${file}: cache`)
    assert.equal(evaluate(metadata.if, { inputs }), expected, `${file}: module path lookup`)
  }
})

test('the module cache resolves only GOMODCACHE through the actual action shell', () => {
  const metadata = action('setup-go').runs.steps.find((step: any) => step.id === 'modules')
  const cache = moduleCache()
  assert.ok(metadata && cache, 'a module-only cache must replace setup-go build caching')
  const fixture = mkdtempSync(join(tmpdir(), 'boxlite-go-cache-'))
  try {
    const modulePath = join(fixture, 'downloaded modules')
    const output = join(fixture, 'output')
    writeFileSync(join(fixture, 'go'), '#!/bin/sh\n[ "$*" = "env GOMODCACHE" ] || exit 19\nprintf "%s\\n" "$MODULE_PATH"\n', { mode: 0o755 })
    execFileSync('bash', ['-eo', 'pipefail', '-c', metadata.run], {
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, GITHUB_OUTPUT: output, MODULE_PATH: modulePath },
    })
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    assert.equal(evaluate(cache.with.path, { steps: { modules: { outputs } } }), modulePath)
    assert.throws(() => execFileSync('bash', ['-eo', 'pipefail', '-c', metadata.run], {
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, GITHUB_OUTPUT: output, MODULE_PATH: '' },
      stdio: 'pipe',
    }), 'an unavailable module cache path must fail instead of caching an arbitrary directory')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Go native builds cache both the outer Cargo workspace and libkrun workspace', () => {
  const caller = goJob().steps.find((step: any) => step.uses === './.github/actions/setup-rust')
  const manifest = action('setup-rust')
  const inputs = Object.fromEntries(Object.entries<any>(manifest.inputs).map(([name, spec]) =>
    [name, caller.with?.[name] ?? spec.default ?? '']))
  const upstream = manifest.runs.steps.find((step: any) => step.uses?.startsWith('actions-rust-lang/setup-rust-toolchain@'))
  const workspaces = evaluate(upstream.with?.['cache-workspaces'] ?? '. -> target', { inputs }).trim().split('\n').map((line) => line.trim())
  assert.ok(workspaces.includes('. -> target'), 'retain the normal runtime/guest build cache')
  assert.ok(workspaces.includes('src/deps/libkrun-sys/vendor/libkrun -> target'), 'libkrun compiles into a separate Cargo target directory')
  assert.equal(evaluate(upstream.with?.['cache-workspace-crates'] ?? 'false', { inputs }), 'true',
    'native workspace outputs must survive dependency-cache cleanup')
})

test('libkrun is checked out before Rust caching reads its workspace metadata', () => {
  const steps = goJob().steps
  const checkout = steps.findIndex((step: any) => step.uses?.startsWith('actions/checkout@'))
  const submodules = steps.findIndex((step: any) => step.run === 'make setup:submodules')
  const rust = steps.findIndex((step: any) => step.uses === './.github/actions/setup-rust')
  assert.ok(checkout >= 0 && checkout < submodules && submodules < rust,
    'cache metadata needs the pinned libkrun checkout before setup-rust')
  assert.ok(steps.some((step: any) => step.run === 'make coverage:go'), 'every run must still rebuild as needed and execute coverage')
})
