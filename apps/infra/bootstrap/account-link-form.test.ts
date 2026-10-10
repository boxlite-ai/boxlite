// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { loadAccountLinkForm } from './account-link-form.js'

const DEV_TENANT = 'dev-j60pjpmu6neaeaga.us.auth0.com'

function customCode(form: any, id: string): string {
  const component = form.nodes
    .flatMap((node: any) => node.config?.components ?? [])
    .find((entry: any) => entry.id === id)
  assert.equal(component?.type, 'CUSTOM', `${id} is a custom field`)
  return component.config.code
}

/**
 * Just enough of a browser page for the custom fields: elements are plain
 * objects, and `submits` counts the steps a field moves the Form forward.
 */
function page({ stored = new Map<string, string>(), navigation = 'navigate' } = {}) {
  const submits: number[] = []
  const head: any[] = []
  const rootClasses = new Set<string>()
  // The page's heading once Forms has rendered it, and what went in above it.
  const heading = { shown: false, above: [] as any[] }
  const byId = (id: string) => [...head, ...heading.above].find((item) => item.id === id) ?? null
  const element = (tagName: string): any => {
    const node: any = {
      tagName,
      value: '',
      children: [] as any[],
      listeners: {} as Record<string, () => void>,
      append: (...items: any[]) => node.children.push(...items),
      appendChild: (item: any) => node.children.push(item),
      addEventListener: (type: string, listener: () => void) => (node.listeners[type] = listener),
    }
    return node
  }
  const document = {
    createElement: element,
    documentElement: {
      classList: { toggle: (name: string, on: boolean) => (on ? rootClasses.add(name) : rootClasses.delete(name)) },
    },
    head: { appendChild: (item: any) => head.push(item) },
    getElementById: byId,
    querySelector: (selector: string) =>
      selector === '.af-componentId-intro' && heading.shown
        ? { before: (item: any) => heading.above.push(item) }
        : null,
  }
  const window = {
    performance: { getEntriesByType: () => [{ type: navigation }] },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  }
  return { document, window, head, heading, submits, stored, rootClasses }
}

/**
 * A custom field as Forms runs it: `getParams()` throws until Forms has
 * resolved the field's params, and Forms then calls the field's `update()`.
 * `getValue()` resolves to the field's own `getValue()`, never a value the
 * Action seeded.
 */
function field(code: string, name: string, browser: ReturnType<typeof page>, params: Record<string, string>) {
  const factory = runInNewContext(`${code}\n;${name}`, {
    document: browser.document,
    window: browser.window,
    setTimeout,
  })
  let resolved = false
  const handler = factory({
    form: { goForward: () => browser.submits.push(Date.now()) },
    custom: {
      getValue: async () => handler.getValue(),
      getParams: () => {
        if (!resolved) throw new Error('You cannot call context.custom.getParams() before init()')
        return params
      },
    },
  })
  return {
    handler,
    resolveParams() {
      resolved = true
      handler.update?.()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('the link Form carries the login page font, logo and styles for a configured tenant', () => {
  const form = loadAccountLinkForm(DEV_TENANT)
  for (const id of ['account', 'cancel']) assert.doesNotMatch(customCode(form, id), /__[A-Z_]+_JSON__/)

  const account = customCode(form, 'account')
  assert.match(account, /const fontUrl = "https:\/\/dev\.boxlite\.ai\/auth0\/[^"]+\.woff2"/)
  assert.match(account, /const logoUrl = "https:\/\/dev\.boxlite\.ai\/auth0\/[^"]+\.png"/)
  assert.match(account, /\.bl-link-cancel \{/)
})

test('a tenant no stage names keeps Auth0 defaults instead of another stage assets', () => {
  const account = customCode(loadAccountLinkForm('unknown.us.auth0.com'), 'account')

  assert.match(account, /const fontUrl = null/)
  assert.match(account, /const logoUrl = null/)
})

test('the address field defines the theme font as ulp-font, and none without one', () => {
  const dressed = page()
  field(customCode(loadAccountLinkForm(DEV_TENANT), 'account'), 'linkAccountField', dressed, {}).handler.init()
  assert.match(
    dressed.head[0].textContent,
    /^@font-face \{ font-family: 'ulp-font'; src: url\('https:\/\/dev\.boxlite\.ai\/auth0\/[^']+\.woff2'\) format\('woff2'\); \}/,
  )

  const plain = page()
  field(
    customCode(loadAccountLinkForm('unknown.us.auth0.com'), 'account'),
    'linkAccountField',
    plain,
    {},
  ).handler.init()
  assert.doesNotMatch(plain.head[0].textContent, /@font-face/)
})

test('the address field puts the logo above the heading once, even when the heading renders late', async () => {
  const code = customCode(loadAccountLinkForm(DEV_TENANT), 'account')

  const early = page()
  early.heading.shown = true
  const first = field(code, 'linkAccountField', early, {})
  first.handler.init()
  await settle()
  first.resolveParams()
  assert.equal(early.heading.above.length, 1)
  assert.match(early.heading.above[0].src, /^https:\/\/dev\.boxlite\.ai\/auth0\/[^/]+\.png$/)

  const late = page()
  const second = field(code, 'linkAccountField', late, {})
  second.handler.init()
  await settle()
  assert.equal(late.heading.above.length, 0)
  late.heading.shown = true
  second.resolveParams()
  assert.equal(late.heading.above.length, 1)
})

test('the link Form passes the address, mode and render id to its custom fields as params', () => {
  const form = loadAccountLinkForm(DEV_TENANT)
  const params = (id: string) =>
    form.nodes.flatMap((node: any) => node.config?.components ?? []).find((entry: any) => entry.id === id).config.params

  assert.deepEqual(params('account'), { address: '{{vars.address}}', mode: '{{vars.mode}}' })
  assert.deepEqual(params('cancel'), { render: '{{vars.render}}' })
})

test('the address field shows the address once Forms resolves its params', async () => {
  const browser = page()
  const account = field(customCode(loadAccountLinkForm(DEV_TENANT), 'account'), 'linkAccountField', browser, {
    address: 'ada@example.com',
  })

  const input = account.handler.init()
  assert.equal(input.value, '')
  account.resolveParams()

  assert.equal(input.value, 'ada@example.com')
  assert.equal(input.disabled, true)
  assert.equal(browser.head.length, 1)
})

test('the address field hides the password field in code mode only', () => {
  const code = customCode(loadAccountLinkForm(DEV_TENANT), 'account')
  const shown = (mode: string) => {
    const browser = page()
    const account = field(code, 'linkAccountField', browser, { address: 'ada@example.com', mode })
    account.handler.init()
    account.resolveParams()
    return browser.rootClasses.has('bl-link-code')
  }

  assert.equal(shown('code'), true)
  assert.equal(shown('password'), false)
  assert.match(code, /\.bl-link-code \.af-componentId-password \{\\n {2}display: none !important/)
})

test('the address field leaves an unresolved template out', () => {
  const account = field(customCode(loadAccountLinkForm(DEV_TENANT), 'account'), 'linkAccountField', page(), {
    address: '{{vars.address}}',
  })

  const input = account.handler.init()
  account.resolveParams()

  assert.equal(input.value, '')
})

test('Cancel answers cancel and moves the Form forward', async () => {
  const browser = page()
  const cancel = field(customCode(loadAccountLinkForm(DEV_TENANT), 'cancel'), 'linkCancelField', browser, {
    render: 'render-1',
  })

  const line = cancel.handler.init()
  cancel.resolveParams()
  await settle()
  assert.equal(browser.submits.length, 0)
  assert.equal(cancel.handler.getValue(), '')

  line.children.find((child: any) => child.tagName === 'button').listeners.click()

  assert.equal(browser.submits.length, 1)
  assert.equal(cancel.handler.getValue(), 'cancel')
})

test('a second load of one render, or a reload, cancels by itself', async () => {
  const code = customCode(loadAccountLinkForm(DEV_TENANT), 'cancel')
  const stored = new Map<string, string>()

  const load = async (browser: ReturnType<typeof page>, render: string) => {
    const cancel = field(code, 'linkCancelField', browser, { render })
    cancel.handler.init()
    cancel.resolveParams()
    await settle()
    return cancel.handler
  }

  const first = page({ stored })
  await load(first, 'render-1')
  assert.equal(first.submits.length, 0)

  const copied = page({ stored })
  const again = await load(copied, 'render-1')
  assert.equal(copied.submits.length, 1)
  assert.equal(again.getValue(), 'cancel')

  const reloaded = page({ navigation: 'reload' })
  await load(reloaded, 'render-2')
  assert.equal(reloaded.submits.length, 1)

  const next = page({ stored })
  await load(next, 'render-3')
  assert.equal(next.submits.length, 0)
})
