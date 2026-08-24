// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindActionArgs,
  createActionArgs,
  customApiArgs,
  deployActionArgs,
  enableRpLogoutDiscoveryArgs,
  spaApplicationArgs,
} from './auth0.js'

function valueAfter(args: any, flag: any) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('spaApplicationArgs registers both the dashboard and the CLI loopback callback', () => {
  const args = spaApplicationArgs({ stackDomain: 'dev.example.com' })
  // RFC 8252 §8.3 requires the IPv4 loopback literal, not `localhost`.
  assert.equal(valueAfter(args, '--callbacks'), 'https://dev.example.com,http://127.0.0.1:5555/callback')
  assert.equal(valueAfter(args, '--logout-urls'), 'https://dev.example.com')
  assert.equal(valueAfter(args, '--type'), 'spa')
})

test('spaApplicationArgs rejects a URL where a hostname is required', () => {
  assert.throws(() => spaApplicationArgs({ stackDomain: 'https://dev.example.com' }), /must be a bare hostname/)
  assert.throws(() => spaApplicationArgs({ stackDomain: '' }), /must be a bare hostname/)
})

test('customApiArgs derives the identifier that becomes OIDC_AUDIENCE', () => {
  assert.equal(valueAfter(customApiArgs({ stackDomain: 'dev.example.com' }), '--identifier'), 'https://dev.example.com/api')
})

test('createActionArgs targets the post-login trigger with the supplied body', () => {
  const args = createActionArgs({ code: 'exports.onExecutePostLogin = async () => {}' })
  assert.equal(valueAfter(args, '--trigger'), 'post-login')
  assert.equal(valueAfter(args, '--code'), 'exports.onExecutePostLogin = async () => {}')
})

test('createActionArgs refuses an empty Action body', () => {
  assert.throws(() => createActionArgs({ code: '   ' }), /Action body is required/)
})

test('deployActionArgs deploys by id, which is a distinct step from binding', () => {
  assert.deepEqual(deployActionArgs('act_123'), ['actions', 'deploy', 'act_123'])
  assert.throws(() => deployActionArgs(''), /actionId is required/)
})

test('bindActionArgs binds the deployed Action to the post-login flow', () => {
  const args = bindActionArgs({ actionId: 'act_123' })
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'actions/triggers/post-login/bindings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    bindings: [{ ref: { type: 'action_id', value: 'act_123' }, display_name: 'boxlite-custom-claims' }],
  })
})

test('bindActionArgs preserves other bindings already on the flow', () => {
  // The PATCH replaces the entire binding list, so an unrelated Action already
  // on the post-login flow must be carried through or it is silently unbound.
  const args = bindActionArgs({
    actionId: 'act_new',
    existingBindings: [{ action: { id: 'act_other' }, display_name: 'someone-elses-action' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_other' }, display_name: 'someone-elses-action' },
    { ref: { type: 'action_id', value: 'act_new' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('bindActionArgs skips a binding whose Action is gone instead of throwing', () => {
  // A binding can arrive with no `action` object once the Action behind it is
  // gone. Dereferencing that while rebuilding the list throws before the PATCH
  // is built, so bootstrap dies with the new Action deployed but never bound —
  // nothing is unbound, but the stage is left half-provisioned.
  const args = bindActionArgs({
    actionId: 'act_new',
    existingBindings: [{ display_name: 'legacy-orphan' }, { action: { id: 'act_other' }, display_name: 'keeper' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_other' }, display_name: 'keeper' },
    { ref: { type: 'action_id', value: 'act_new' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('bindActionArgs does not duplicate itself when already bound', () => {
  const args = bindActionArgs({
    actionId: 'act_123',
    existingBindings: [{ action: { id: 'act_123' }, display_name: 'boxlite-custom-claims' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_123' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('enableRpLogoutDiscoveryArgs flips the tenant logout-discovery setting', () => {
  const args = enableRpLogoutDiscoveryArgs()
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'tenants/settings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    oidc_logout: { rp_logout_end_session_endpoint_discovery: true },
  })
})
