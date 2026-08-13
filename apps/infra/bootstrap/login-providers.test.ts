// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOGIN_PROVIDERS,
  decideLoginAction,
  decideMissingCliAction,
  installCommand,
  selectProviders,
  summarizeLoginResults,
} from './login-providers.js'

test('every provider is a browser sign-in with a status probe', () => {
  // A provider without a status probe would re-open a browser on every run.
  for (const provider of LOGIN_PROVIDERS) {
    assert.ok(provider.statusArgs.length > 0, `${provider.key} has no status probe`)
    assert.ok(provider.loginArgs.length > 0, `${provider.key} has no login command`)
  }
  assert.deepEqual(
    LOGIN_PROVIDERS.map((provider) => provider.key),
    ['aws', 'github', 'auth0'],
  )
})

test('only Auth0 is optional — AWS and GitHub are always needed', () => {
  const optional = LOGIN_PROVIDERS.filter((provider) => !provider.required).map((provider) => provider.key)
  assert.deepEqual(optional, ['auth0'])
})

test('selectProviders defaults to every provider', () => {
  assert.equal(selectProviders(undefined).length, LOGIN_PROVIDERS.length)
  assert.equal(selectProviders([]).length, LOGIN_PROVIDERS.length)
})

test('selectProviders narrows to the requested providers in order', () => {
  assert.deepEqual(
    selectProviders(['github', 'aws']).map((provider: any) => provider.key),
    ['github', 'aws'],
  )
})

test('selectProviders rejects an unknown provider instead of silently skipping it', () => {
  assert.throws(() => selectProviders(['cloudflare']), /unknown provider 'cloudflare'/)
})

test('decideMissingCliAction offers an install only when the manager is there', () => {
  const install = { manager: 'brew', formula: 'auth0' }
  assert.equal(decideMissingCliAction({ install, managerAvailable: true }), 'offer-install')
  // Installing Homebrew itself is not something `npm run login` should do as a
  // side effect, so without it the operator is told how instead.
  assert.equal(decideMissingCliAction({ install, managerAvailable: false }), 'report')
})

test('decideMissingCliAction reports a provider it has no recipe for', () => {
  assert.equal(decideMissingCliAction({ install: undefined, managerAvailable: true }), 'report')
  assert.equal(decideMissingCliAction({ install: { manager: 'apt', formula: 'auth0' }, managerAvailable: true }), 'report')
  assert.equal(
    decideMissingCliAction({ install: { manager: 'constructor', formula: 'auth0' }, managerAvailable: true }),
    'report',
  )
  assert.equal(installCommand({ manager: 'constructor', formula: 'auth0' }), null)
})

test('installCommand names the formula, which differs from the binary', () => {
  const aws = LOGIN_PROVIDERS.find((provider) => provider.key === 'aws')
  assert.ok(aws)
  assert.equal(aws.command, 'aws')
  assert.deepEqual(installCommand(aws.install), { command: 'brew', args: ['install', 'awscli'], label: 'Homebrew' })
  assert.equal(installCommand(undefined), null)
})

test('every provider carries an install recipe', () => {
  // A missing recipe silently degrades the prompt back to "install it yourself".
  for (const provider of LOGIN_PROVIDERS) {
    assert.ok(installCommand(provider.install), `${provider.key} has no install recipe`)
  }
})

test('decideLoginAction leaves a working session alone', () => {
  assert.equal(decideLoginAction({ cliInstalled: true, authenticated: true, force: false }), 'skip')
})

test('decideLoginAction signs in when there is no session', () => {
  assert.equal(decideLoginAction({ cliInstalled: true, authenticated: false, force: false }), 'login')
})

test('decideLoginAction re-authenticates on --force', () => {
  assert.equal(decideLoginAction({ cliInstalled: true, authenticated: true, force: true }), 'login')
})

test('decideLoginAction reports a missing CLI rather than trying to run it', () => {
  assert.equal(decideLoginAction({ cliInstalled: false, authenticated: false, force: false }), 'missing-cli')
  assert.equal(decideLoginAction({ cliInstalled: false, authenticated: true, force: true }), 'missing-cli')
})

test('summarizeLoginResults passes when nothing failed', () => {
  const summary = summarizeLoginResults([
    { label: 'AWS', status: 'skip', required: true },
    { label: 'GitHub', status: 'logged-in', required: true },
  ])
  assert.deepEqual(summary, { ok: true, failed: [], skippedOptional: [] })
})

test('summarizeLoginResults reports an absent optional CLI without failing', () => {
  const summary = summarizeLoginResults([
    { label: 'AWS', status: 'skip', required: true },
    { label: 'Auth0', status: 'missing-cli', required: false },
  ])
  assert.equal(summary.ok, true)
  assert.deepEqual(summary.skippedOptional, ['Auth0'])
})

test('summarizeLoginResults fails when a REQUIRED CLI is absent', () => {
  // Absent and required is as blocking as a failed sign-in: bootstrap cannot
  // proceed without it, so the run must not report success.
  const summary = summarizeLoginResults([
    { label: 'AWS', status: 'missing-cli', required: true },
    { label: 'GitHub', status: 'logged-in', required: true },
  ])
  assert.equal(summary.ok, false)
  assert.deepEqual(summary.failed, ['AWS'])
  assert.deepEqual(summary.skippedOptional, [])
})

test('summarizeLoginResults fails when a login failed', () => {
  const summary = summarizeLoginResults([
    { label: 'AWS', status: 'failed', required: true },
    { label: 'GitHub', status: 'logged-in', required: true },
  ])
  assert.equal(summary.ok, false)
  assert.deepEqual(summary.failed, ['AWS'])
})
