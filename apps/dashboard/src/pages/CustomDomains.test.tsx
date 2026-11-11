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
  prepareCustomDomain: vi.fn(),
  advanceCustomDomain: vi.fn(),
  deleteCustomDomain: vi.fn(),
  bindDomain: vi.fn(),
  unbindDomain: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
const feedback = vi.hoisted(() => ({ copy: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/copy-text', () => ({ copyToClipboard: feedback.copy }))
vi.mock('sonner', () => ({ toast: { success: feedback.success, error: feedback.error } }))
const domain: CustomDomain = {
  id: 'config-1',
  hostname: 'app.example.com',
  phase: 'ready',
  ready: true,
  confirmed: true,
  submissionStatus: 'accepted',
  progress: 'ready',
  retryAfter: 10,
  dnsChecks: [],
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
      (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
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
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Get all three DNS records')
    input('Custom hostname', 'app.example.com')
    expect(button('Get DNS configuration').disabled).toBe(true)
    expect(api.createCustomDomain).not.toHaveBeenCalled()
  })

  it('creates a configuration then displays provider-issued DNS records and retries', async () => {
    response.domains = []
    api.createCustomDomain.mockImplementation(async () => {
      response = {
        ...response,
        domains: [
          {
            ...domain,
            phase: 'pending_certificate_dns',
            ready: false,
            confirmed: false,
            submissionStatus: 'not_submitted',
          },
        ],
      }
      return response.domains[0]
    })
    await render()
    await click('Add custom domain')
    input('Custom hostname', 'app.example.com')
    await click('Get DNS configuration')
    expect(api.createCustomDomain).toHaveBeenCalledWith('org-1', 'app.example.com')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('abc.authorize.certificatemanager.goog.')
    await click('Configured, verify')
    expect(api.verifyCustomDomain).toHaveBeenCalledWith('org-1', 'config-1')
    expect(button('Bind')).toBeUndefined()
    expect(api.bindDomain).not.toHaveBeenCalled()
  })

  it('binds a ready hostname using the existing Box target operation', async () => {
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    input('Box ID or name', 'my-box')
    input('Port', '8080')
    await click('Bind')
    expect(api.bindDomain).toHaveBeenCalledWith('org-1', 'app.example.com', 'my-box', 8080)
  })

  it('shows DNS verification progress and only acknowledges confirmed submission', async () => {
    response.domains = [
      {
        ...domain,
        phase: 'pending_certificate_dns',
        confirmed: false,
        submissionStatus: 'not_submitted',
        ready: false,
      },
    ]
    let complete!: () => void
    api.verifyCustomDomain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = () => {
            response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
            resolve()
          }
        }),
    )
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    await act(async () => button('Configured, verify').click())
    await settle()
    try {
      expect(document.body.textContent).toContain('Verifying DNS, please wait…')
    } finally {
      await act(async () => complete())
      await settle()
    }
    expect(document.body.textContent).toContain('DNS verification passed. HTTPS is being enabled.')
    expect(button('Bind')).toBeUndefined()
    expect(api.bindDomain).not.toHaveBeenCalled()
  })

  it('distinguishes an unknown submission from an accepted certificate request', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false, submissionStatus: 'unknown' }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(document.body.textContent).toContain('Confirming whether the certificate request was accepted')
    expect(document.body.textContent).not.toContain('HTTPS is being enabled')
  })

  it('does not advance or prepare a draft from ordinary browsing or input edits', async () => {
    response.domains = [
      { ...domain, ready: false, confirmed: false, submissionStatus: 'not_submitted', dnsRecords: [] },
    ]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(button('Continue getting DNS configuration')).toBeDefined()
    expect(api.prepareCustomDomain).not.toHaveBeenCalled()
    expect(api.advanceCustomDomain).not.toHaveBeenCalled()
    expect(api.verifyCustomDomain).not.toHaveBeenCalled()
    expect(api.createCustomDomain).not.toHaveBeenCalled()
  })

  it('does not allow a superseded application to verify or bind again', async () => {
    response.domains = [{ ...domain, ready: false, phase: 'superseded', errorCode: 'domain_superseded' }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(button('Continue HTTPS setup')).toBeUndefined()
    expect(button('Bind')).toBeUndefined()
    expect(api.bindDomain).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('no longer valid')
  })

  it('polls explicit advance only while the confirmed dialog is visible', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await render()
    vi.useFakeTimers()
    try {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_050)
      })
      expect(api.advanceCustomDomain).toHaveBeenCalledTimes(1)
      expect(api.verifyCustomDomain).not.toHaveBeenCalled()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(api.advanceCustomDomain).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    }
  })

  it('explains where to wait and distinguishes the certificate CNAME from traffic DNS', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    const text = document.querySelector('[role="dialog"]')!.textContent
    expect(text).toContain('60 minutes')
    expect(text).toContain('10 seconds')
    expect(text).toContain('After you leave')
    expect(text).toContain('every minute while running')
    expect(text).toContain('If the API is stopped or paused')
    expect(text).toContain('Certificate authorization')
    expect(text).toContain('Traffic routing')
    expect(document.querySelector('[aria-label="Copy name for Certificate authorization"]')).not.toBeNull()
    expect(text).toContain('do not replace the traffic CNAME')
  })

  it('explains terminal certificate retry delays without promising immediate issuance', async () => {
    response.domains = [
      { ...domain, phase: 'provisioning', ready: false, errorCode: 'certificate_provisioning_failed' },
    ]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(document.body.textContent).toContain('one hour')
    expect(document.body.textContent).toContain('pki.goog')
  })

  it('allows unbind and explicit deletion after subscription expiry while retaining DNS guidance', async () => {
    response.subscription = 'required'
    held = [
      { hostname: domain.hostname, url: `https://${domain.hostname}`, target: { type: 'box', box: 'box-1', port: 80 } },
    ]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(button('Continue HTTPS setup')).toBeUndefined()
    expect(button('Bind').disabled).toBe(true)
    await click('Unbind')
    expect(api.unbindDomain).toHaveBeenCalledWith('org-1', domain.hostname)
    await click('Delete configuration')
    expect(api.deleteCustomDomain).not.toHaveBeenCalled()
    await click('Confirm deletion')
    expect(api.deleteCustomDomain).toHaveBeenCalledWith('org-1', domain.id)
  })

  it.each([true, false])('copies the exact authorization record with success=%s feedback', async (success) => {
    feedback.copy.mockResolvedValue(success)
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Copy name for Certificate authorization"]')!.click(),
    )
    expect(feedback.copy).toHaveBeenCalledWith(domain.dnsRecords[2].name)
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Copy value for Certificate authorization"]')!.click(),
    )
    expect(feedback.copy).toHaveBeenLastCalledWith(domain.dnsRecords[2].value)
    if (success) expect(feedback.success).toHaveBeenCalledWith('DNS value copied')
    else
      expect(feedback.error).toHaveBeenCalledWith('Could not copy DNS record. Select the value and copy it manually.')
  })

  it('keeps current actions in the shared footer and collapses secondary help', async () => {
    response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    expect(document.querySelectorAll('[role="dialog"] h2')).toHaveLength(1)
    const disclosures = [...document.querySelectorAll<HTMLDetailsElement>('[role="dialog"] details')]
    expect(disclosures[0].open).toBe(true)
    expect(disclosures[1].open).toBe(false)
    expect(button('Configured, verify').closest('.form-dialog-footer')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('disconnects any previous organization')
    expect(document.querySelectorAll('[aria-label^="Copy name for"]')).toHaveLength(3)
    expect(api.verifyCustomDomain).not.toHaveBeenCalled()
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
