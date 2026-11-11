// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomDomains from './CustomDomains'
import type { CustomDomain, CustomDomainList, HeldDomain } from '@/api/domain-types'

const api = vi.hoisted(() => ({
  listCustomDomains: vi.fn(),
  createCustomDomain: vi.fn(),
  verifyCustomDomain: vi.fn(),
  deleteCustomDomain: vi.fn(),
  bindDomain: vi.fn(),
  unbindDomain: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
const domain: CustomDomain = {
  id: 'config-1',
  hostname: 'app.example.com',
  phase: 'ready',
  ready: true,
  errorCode: null,
  challengeExpiresAt: null,
  dnsRecords: [
    { name: 'app.example.com', type: 'CNAME', value: 'box.platform.com' },
    { name: '_boxlite-verification.app.example.com', type: 'TXT', value: 'boxlite-verification=challenge' },
    { name: '_acme-challenge_abc.app.example.com', type: 'CNAME', value: 'abc.authorize.certificatemanager.goog.' },
  ],
}

describe('Custom domains setup', () => {
  let root: Root
  let client: QueryClient
  let response: CustomDomainList
  let held: HeldDomain[]
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    response = { enabled: true, subscription: 'active', domains: [domain] }
    held = []
    api.listCustomDomains.mockImplementation(async () => response)
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    document.body.innerHTML = ''
  })
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  async function render(organizationId = 'org-1', canManage = true) {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <CustomDomains key={organizationId} organizationId={organizationId} canManage={canManage} held={held} />
        </QueryClientProvider>,
      ),
    )
    await settle()
  }
  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    )!
  }
  async function click(label: string) {
    await act(async () => button(label).click())
    await settle()
  }
  function input(label: string, value: string) {
    const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('shows the guide to a free organization but prevents creating, checking and binding', async () => {
    response.subscription = 'required'
    await render()
    await click('Add custom domain')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Add the traffic CNAME')
    input('Custom hostname', 'app.example.com')
    expect(button('Get DNS records').disabled).toBe(true)
    expect(api.createCustomDomain).not.toHaveBeenCalled()
  })

  it('creates a configuration then displays provider-issued DNS records and retries', async () => {
    response.domains = []
    api.createCustomDomain.mockImplementation(async () => {
      response = { ...response, domains: [{ ...domain, phase: 'pending_certificate_dns', ready: false }] }
      return response.domains[0]
    })
    await render()
    await click('Add custom domain')
    input('Custom hostname', 'app.example.com')
    await click('Get DNS records')
    expect(api.createCustomDomain).toHaveBeenCalledWith('org-1', 'app.example.com')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('abc.authorize.certificatemanager.goog.')
    await click('Check DNS / retry')
    expect(api.verifyCustomDomain).toHaveBeenCalledWith('org-1', 'config-1')
    input('Box ID or name', 'box-1')
    expect(button('Bind').disabled).toBe(true)
  })

  it('binds a ready hostname using the existing Box target operation', async () => {
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('section > button')!.click())
    input('Box ID or name', 'my-box')
    input('Port', '8080')
    await click('Bind')
    expect(api.bindDomain).toHaveBeenCalledWith('org-1', 'app.example.com', 'my-box', 8080)
  })

  it('acknowledges an asynchronous check while keeping an unready domain unbindable', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    let complete!: () => void
    api.verifyCustomDomain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
    )
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('section > button')!.click())
    await act(async () => button('Check DNS / retry').click())
    await settle()
    try {
      expect(document.body.textContent).toContain('Requesting check…')
    } finally {
      await act(async () => complete())
      await settle()
    }
    expect(document.body.textContent).toContain('Check requested')
    expect(document.body.textContent).toContain('not a confirmation that DNS or HTTPS is ready')
    input('Box ID or name', 'box-1')
    expect(button('Bind').disabled).toBe(true)
  })

  it('explains where to wait and distinguishes the certificate CNAME from traffic DNS', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('section > button')!.click())
    const text = document.querySelector('[role="dialog"]')!.textContent
    expect(text).toContain('60 minutes')
    expect(text).toContain('10 seconds')
    expect(text).toContain('close this dialog')
    expect(text).toContain('Certificate authorization')
    expect(text).toContain('Traffic routing')
    expect(text).toContain('Copy name')
    expect(text).toContain('do not replace the traffic CNAME')
  })

  it('explains terminal certificate retry delays without promising immediate issuance', async () => {
    response.domains = [
      { ...domain, phase: 'provisioning', ready: false, errorCode: 'certificate_provisioning_failed' },
    ]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('section > button')!.click())
    expect(document.body.textContent).toContain('one hour')
    expect(document.body.textContent).toContain('pki.goog')
  })

  it('allows unbind and explicit deletion after subscription expiry while retaining DNS guidance', async () => {
    response.subscription = 'required'
    held = [
      { hostname: domain.hostname, url: `https://${domain.hostname}`, target: { type: 'box', box: 'box-1', port: 80 } },
    ]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('section > button')!.click())
    expect(button('Check DNS / retry').disabled).toBe(true)
    expect(button('Bind').disabled).toBe(true)
    await click('Unbind')
    expect(api.unbindDomain).toHaveBeenCalledWith('org-1', domain.hostname)
    await click('Delete configuration')
    expect(api.deleteCustomDomain).not.toHaveBeenCalled()
    await click('Confirm deletion')
    expect(api.deleteCustomDomain).toHaveBeenCalledWith('org-1', domain.id)
  })

  it('drops an old organization dialog on switch and does not fetch without management permission', async () => {
    await render()
    await click('Add custom domain')
    response = { ...response, domains: [] }
    await render('org-2')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(api.listCustomDomains).toHaveBeenLastCalledWith('org-2')
    api.listCustomDomains.mockClear()
    await render('org-3', false)
    expect(api.listCustomDomains).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })
})
