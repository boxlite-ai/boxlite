// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { Auth0BrandingDeployer } from './auth0-branding.js'

const THEME = {
  colors: { page_background: '#13161B' },
  fonts: { reference_text_size: 13 },
  widget: { logo_url: 'https://assets.example.com/logo.png' },
}
const TEMPLATE = `
  <html>{%- auth0:head -%}<style>
  @font-face { src: url('https://assets.example.com/mono-400.woff2') }
  @font-face { src: url('https://assets.example.com/mono-500.woff2') }
  </style><body>{%- auth0:widget -%}</body></html>
`
const CUSTOM_TEXT = {
  language: 'en',
  prompts: { login: { login: { title: 'Welcome back' } }, signup: { signup: { title: 'Create account' } } },
}
const INPUT = { theme: THEME, template: TEMPLATE, customText: CUSTOM_TEXT, auth0Origin: 'https://auth.example.com' }

function assetResponse(body = 'asset') {
  return new Response(body, { status: 200, headers: { 'access-control-allow-origin': '*' } })
}

function trackedAssetResponse(url: string, events: string[]) {
  let reads = 0
  return {
    status: 200,
    headers: new Headers({ 'access-control-allow-origin': '*' }),
    body: {
      getReader: () => ({
        read: async () => {
          if (reads++ === 0) return { done: false, value: new TextEncoder().encode('asset') }
          events.push(`validated:${url}`)
          return { done: true, value: undefined }
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
      cancel: async () => undefined,
    },
  } as unknown as Response
}

test('all bounded asset probes finish before the first Auth0 write', async () => {
  const events: string[] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async (url, init) => {
      events.push(`fetch:${url}`)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(new Headers(init.headers).get('origin'), 'https://auth.example.com')
      assert.ok(init.signal instanceof AbortSignal)
      return trackedAssetResponse(url, events)
    },
    read: (args) => {
      events.push(`read:${args[2]}`)
      return { themeId: 'thm_1' }
    },
    write: (args) => events.push(`write:${args[1]}:${args[2]}`),
  })

  const result = await deployer.apply(INPUT)
  const firstWrite = events.findIndex((event) => event.startsWith('write:'))
  const lastValidation = events.findLastIndex((event) => event.startsWith('validated:'))
  assert.equal(events.filter((event) => event.startsWith('fetch:')).length, 3)
  assert.equal(events.filter((event) => event.startsWith('validated:')).length, 3)
  assert.equal(events.filter((event) => event.startsWith('write:')).length, 4)
  assert.ok(firstWrite >= 0)
  assert.ok(lastValidation < firstWrite)
  assert.ok(
    events
      .slice(0, firstWrite)
      .every((event) => event.startsWith('fetch:') || event.startsWith('validated:') || event.startsWith('read:')),
  )
  assert.ok(events.indexOf('read:branding/themes/default') > lastValidation)
  assert.deepEqual(result, { themeCreated: false, customTextCount: 2 })
})

test('only an explicit default-theme 404 selects the create path', async () => {
  const writes: string[][] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async () => assetResponse(),
    read: () => {
      throw Object.assign(new Error('theme not found'), { stderr: 'Request failed with status code 404' })
    },
    write: (args) => writes.push(args),
  })
  const result = await deployer.apply(INPUT)
  assert.equal(writes[0][1], 'post')
  assert.equal(writes[0][2], 'branding/themes')
  assert.equal(result.themeCreated, true)
})

test('a non-404 theme read error is rethrown before the first write', async () => {
  const writes: string[][] = []
  const cause = Object.assign(new Error('unauthorized'), { stderr: 'Request failed with status code 401' })
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async () => assetResponse(),
    read: () => {
      throw cause
    },
    write: (args) => writes.push(args),
  })
  await assert.rejects(() => deployer.apply(INPUT), (error) => error === cause)
  assert.deepEqual(writes, [])
})

test('a successful theme read without an id fails before the first write', async () => {
  const writes: string[][] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async () => assetResponse(),
    read: () => ({}),
    write: (args) => writes.push(args),
  })
  await assert.rejects(() => deployer.apply(INPUT), /without a themeId/)
  assert.deepEqual(writes, [])
})

test('a redirect response stops the apply before any Auth0 call', async () => {
  const calls: string[] = []
  let bodyCancelled = false
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async (_url, init) => {
      assert.equal(init.redirect, 'error')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('redirect'))
          },
          cancel() {
            bodyCancelled = true
          },
        }),
        { status: 302, headers: { location: 'https://other.example.com' } },
      )
    },
    read: () => {
      calls.push('read')
      return {}
    },
    write: () => calls.push('write'),
  })
  await assert.rejects(() => deployer.apply(INPUT), /returned 302/)
  assert.deepEqual(calls, [])
  assert.equal(bodyCancelled, true)
})

test('an asset fetch failure stops the apply before any Auth0 call', async () => {
  const calls: string[] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async () => {
      throw new Error('network unavailable')
    },
    read: () => {
      calls.push('read')
      return {}
    },
    write: () => calls.push('write'),
  })
  await assert.rejects(() => deployer.apply(INPUT), /could not reach/)
  assert.deepEqual(calls, [])
})

test('an oversized asset is cancelled before any Auth0 call', async () => {
  const calls: string[] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async () => assetResponse('12345'),
    read: () => {
      calls.push('read')
      return {}
    },
    write: () => calls.push('write'),
    maxAssetBytes: 4,
  })
  await assert.rejects(() => deployer.apply(INPUT), /4-byte download limit/)
  assert.deepEqual(calls, [])
})

test('the asset timeout aborts a stalled fetch before any Auth0 call', async () => {
  const calls: string[] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    read: () => {
      calls.push('read')
      return {}
    },
    write: () => calls.push('write'),
    assetTimeoutMs: 1,
  })
  await assert.rejects(() => deployer.apply(INPUT), /could not reach/)
  assert.deepEqual(calls, [])
})

test('the asset timeout aborts a stalled response body before any Auth0 call', async () => {
  const calls: string[] = []
  const deployer = new Auth0BrandingDeployer({
    fetchAsset: async (_url, init) => {
      const signal = init.signal as AbortSignal
      return {
        status: 200,
        headers: new Headers({ 'access-control-allow-origin': '*' }),
        body: {
          getReader: () => ({
            read: () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
              }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
          cancel: async () => undefined,
        },
      } as unknown as Response
    },
    read: () => {
      calls.push('read')
      return {}
    },
    write: () => calls.push('write'),
    assetTimeoutMs: 1,
  })
  await assert.rejects(() => deployer.apply(INPUT), (error: any) => error?.name === 'TimeoutError')
  assert.deepEqual(calls, [])
})
