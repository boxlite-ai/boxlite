// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, QueryObserver, focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CustomDomains from './CustomDomains'
import { queryKeys } from '@/hooks/queries/queryKeys'
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
const feedback = vi.hoisted(() => ({ copy: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('@/lib/copy-text', () => ({ copyToClipboard: feedback.copy }))
vi.mock('sonner', () => ({ toast: { success: feedback.success, error: feedback.error, info: feedback.info } }))
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
    api.verifyCustomDomain.mockImplementation(async () => response.domains[0])
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
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20)
      else await new Promise((resolve) => setTimeout(resolve, 20))
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

  it.each(['active', 'unavailable'] as const)(
    'quietly refreshes pending status each minute until ready with subscription %s',
    async (subscription) => {
      response = { ...response, subscription, domains: [{ ...domain, ready: false, phase: 'provisioning' }] }
      vi.useFakeTimers()
      focusManager.setFocused(true)
      try {
        await render()
        const row = button('Manage app.example.com')
        const toolbar = document.querySelector('.resource-toolbar')
        expect(row.textContent).toContain('Waiting for https')
        let finish!: (value: CustomDomainList) => void
        api.listCustomDomains.mockImplementationOnce(
          () =>
            new Promise<CustomDomainList>((resolve) => {
              finish = resolve
            }),
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(59_000)
        })
        expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000)
        })
        expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
        expect(button('Manage app.example.com')).toBe(row)
        expect(document.body.textContent).not.toContain('Loading custom domains')
        expect(row.textContent).toContain('Waiting for https')
        await act(async () => {
          finish({ ...response, domains: [domain] })
        })
        await settle()
        expect(button('Manage app.example.com')).toBe(row)
        expect(document.querySelector('.resource-toolbar')).toBe(toolbar)
        expect(row.textContent).toContain(subscription === 'active' ? 'Ready' : 'Setup completed')
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000)
        })
        expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
        expect(api.prepareCustomDomain).not.toHaveBeenCalled()
        expect(api.verifyCustomDomain).not.toHaveBeenCalled()
        expect(api.advanceCustomDomain).not.toHaveBeenCalled()
        expect(feedback.success).not.toHaveBeenCalled()
        expect(feedback.error).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        focusManager.setFocused(undefined)
      }
    },
  )

  it('retains cached status silently after a failed refresh and tries again next minute', async () => {
    response.domains = [{ ...domain, ready: false, phase: 'provisioning' }]
    vi.useFakeTimers()
    focusManager.setFocused(true)
    try {
      await render()
      const row = button('Manage app.example.com')
      api.listCustomDomains.mockRejectedValueOnce(new Error('Temporary read failure'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      await settle()
      expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
      expect(button('Manage app.example.com')).toBe(row)
      expect(row.textContent).toContain('Waiting for https')
      expect(document.body.textContent).not.toContain('Unable to load custom domains.')
      expect(document.body.textContent).not.toContain('Loading custom domains')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
      focusManager.setFocused(undefined)
    }
  })

  it('pauses minute reads in an unconfirmed dialog and hidden tab, then catches up on return', async () => {
    response.domains = [{ ...domain, ready: false, confirmed: false, phase: 'pending_certificate_dns' }]
    vi.useFakeTimers()
    focusManager.setFocused(true)
    try {
      await render()
      await click('Manage app.example.com')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
      await click('Close')
      focusManager.setFocused(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
      await act(async () => focusManager.setFocused(true))
      await settle()
      expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
      await render('org-2', false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      focusManager.setFocused(undefined)
    }
  })

  it.each(['success', 'failure'])(
    'updates an open HTTPS dialog without continuation controls with %s',
    async (outcome) => {
      response = {
        ...response,
        subscription: 'unavailable',
        domains: [{ ...domain, ready: false, phase: 'provisioning' }],
      }
      vi.useFakeTimers()
      focusManager.setFocused(true)
      try {
        await render()
        await click('Manage app.example.com')
        expect(button('Continue HTTPS setup')).toBeUndefined()
        expect(api.advanceCustomDomain).not.toHaveBeenCalled()
        const dialog = document.querySelector('[role="dialog"]')
        const result =
          outcome === 'success'
            ? domain
            : { ...domain, ready: false, phase: 'provisioning' as const, errorCode: 'certificate_provisioning_failed' }
        api.listCustomDomains.mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, domains: [result] })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000)
        })
        expect(api.listCustomDomains).toHaveBeenCalledTimes(3)
        expect(button('Manage app.example.com').textContent).toContain('Waiting for https')
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000)
        })
        await settle()
        expect(document.querySelector('[role="dialog"]')).toBe(dialog)
        expect(button('Manage app.example.com').textContent).toContain(
          outcome === 'success' ? 'Setup completed' : 'Needs attention',
        )
        expect(dialog?.textContent).toContain(
          outcome === 'success' ? 'HTTPS is ready.' : 'HTTPS setup could not be completed. Please try again.',
        )
        expect(api.advanceCustomDomain).not.toHaveBeenCalled()
        expect(api.verifyCustomDomain).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        focusManager.setFocused(undefined)
      }
    },
  )

  it('catches up pending HTTPS on focus even while its cached data is fresh', async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: 300_000 } })
    response = { ...response, domains: [{ ...domain, ready: false, phase: 'provisioning' }] }
    vi.useFakeTimers()
    focusManager.setFocused(true)
    try {
      await render()
      await click('Manage app.example.com')
      await act(async () => focusManager.setFocused(false))
      response = { ...response, domains: [domain] }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
      await act(async () => focusManager.setFocused(true))
      await settle()
      expect(api.listCustomDomains).toHaveBeenCalledTimes(3)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('HTTPS is ready.')
    } finally {
      vi.useRealTimers()
      focusManager.setFocused(undefined)
    }
  })

  it('pauses status reads during DNS verification and resumes after its response', async () => {
    response = {
      ...response,
      domains: [{ ...domain, ready: false, confirmed: false, phase: 'pending_certificate_dns' }],
    }
    let complete!: (result: CustomDomain) => void
    api.verifyCustomDomain.mockImplementation(
      () =>
        new Promise<CustomDomain>((resolve) => {
          complete = resolve
        }),
    )
    vi.useFakeTimers()
    focusManager.setFocused(true)
    try {
      await render()
      await click('Manage app.example.com')
      await click('Configured, verify')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      await act(async () => focusManager.setFocused(false))
      await act(async () => focusManager.setFocused(true))
      await settle()
      expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
      expect(button('Verifying DNS, please wait…').disabled).toBe(true)
      await act(async () => complete({ ...domain, ready: false, phase: 'provisioning' }))
      await settle()
      response = { ...response, domains: [domain] }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      await settle()
      expect(api.listCustomDomains).toHaveBeenCalledTimes(2)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(button('Manage app.example.com').textContent).toContain('Ready')
    } finally {
      vi.useRealTimers()
      focusManager.setFocused(undefined)
    }
  })

  it.each(['accepted', 'unknown', 'not_submitted', 'failed'] as const)(
    'shows confirmed %s progress without a continuation action',
    async (state) => {
      response.domains = [
        {
          ...domain,
          ready: false,
          phase: 'provisioning',
          submissionStatus: state === 'failed' ? 'accepted' : state,
          errorCode: state === 'failed' ? 'certificate_provisioning_failed' : null,
        },
      ]
      await render()
      await click('Manage app.example.com')
      expect(button('Continue HTTPS setup')).toBeUndefined()
      expect(button('Configured, verify')).toBeUndefined()
      expect(button('Continue getting DNS configuration')).toBeUndefined()
      expect(button('Delete configuration')).toBeDefined()
      if (state === 'failed') expect(button('Retry')).toBeDefined()
      else expect(button('Retry')).toBeUndefined()
      expect(api.advanceCustomDomain).not.toHaveBeenCalled()
      expect(api.verifyCustomDomain).not.toHaveBeenCalled()
    },
  )

  it('reads current progress when reopening a confirmed incomplete domain without advancing it', async () => {
    response = { ...response, domains: [{ ...domain, ready: false, phase: 'provisioning' }] }
    await render()
    await click('Manage app.example.com')
    await click('Close')
    api.listCustomDomains.mockResolvedValueOnce({ ...response, domains: [domain] })
    await click('Manage app.example.com')
    expect(api.listCustomDomains).toHaveBeenCalledTimes(3)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('HTTPS is ready.')
    expect(button('Continue HTTPS setup')).toBeUndefined()
    expect(api.advanceCustomDomain).not.toHaveBeenCalled()
    expect(api.verifyCustomDomain).not.toHaveBeenCalled()
  })

  it.each(['empty', 'superseded', 'disabled'])('does not refresh a %s list', async (state) => {
    response.enabled = state !== 'disabled'
    response.domains =
      state === 'empty'
        ? []
        : [{ ...domain, ready: false, phase: state === 'superseded' ? 'superseded' : 'provisioning' }]
    vi.useFakeTimers()
    focusManager.setFocused(true)
    try {
      await render()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000)
      })
      expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      focusManager.setFocused(undefined)
    }
  })

  it.each([
    { phases: [], used: 0 },
    { phases: ['pending_verification'], used: 1 },
    { phases: ['ready'], used: 1 },
    { phases: ['superseded'], used: 0 },
    { phases: ['superseded', 'ready'], used: 1 },
  ])('shows the custom domain allowance for $phases', async ({ phases, used }) => {
    response.domains = phases.map((phase, index) => ({
      ...domain,
      id: `config-${index}`,
      phase: phase as CustomDomain['phase'],
    }))
    await render()
    expect(document.querySelector('.resource-toolbar')?.textContent).toContain(`${used} / 1 custom domains`)
    expect(document.body.textContent).not.toContain('Pending setups count toward the limit.')
    expect(document.body.textContent).not.toContain('One custom domain per organization')
  })

  it('omits the unavailable subscription banner while retaining configuration access', async () => {
    response.subscription = 'unavailable'
    await render()
    expect(document.body.textContent).not.toContain('Subscription eligibility is temporarily unavailable.')
    expect(document.body.textContent).not.toContain('Existing configurations can still be viewed, unbound or deleted.')
    await click('Manage app.example.com')
    expect(button('Delete configuration')).toBeDefined()
  })

  it.each(['loading', 'error'])('does not invent an allowance while the list is %s', async (state) => {
    api.listCustomDomains.mockImplementation(() =>
      state === 'loading' ? new Promise(() => {}) : Promise.reject(new Error('Unavailable')),
    )
    await render()
    expect(document.querySelector('.resource-toolbar')?.textContent).not.toContain('/ 1 custom domains')
  })

  it('opens the add dialog for a free organization but prevents creating', async () => {
    response.subscription = 'required'
    await render()
    await click('Add custom domain')
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
        new Promise<CustomDomain>((resolve) => {
          complete = () => {
            resolve({ ...domain, phase: 'provisioning', ready: false })
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
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(feedback.success).toHaveBeenCalledWith('DNS verification passed.', {
      description: 'HTTPS is being enabled. You can return later to check progress.',
    })
    expect(api.listCustomDomains).toHaveBeenCalledTimes(1)
    expect(client.getQueryData<CustomDomainList>(['custom-domains', 'org-1'])?.domains[0].confirmed).toBe(true)
    response = { ...response, domains: [{ ...domain, phase: 'provisioning', ready: false }] }
    await click('Manage app.example.com')
    expect(document.body.textContent).toContain('DNS verification passed. HTTPS is being enabled.')
    expect(button('Bind')).toBeUndefined()
    expect(api.bindDomain).not.toHaveBeenCalled()
  })

  it('retains failed DNS records and only retries on the next click', async () => {
    response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
    api.verifyCustomDomain
      .mockResolvedValueOnce({
        ...response.domains[0],
        errorCode: 'certificate_dns_mismatch',
        dnsChecks: [{ record: 'certificate', status: 'failed', errorCode: 'certificate_dns_mismatch' }],
      })
      .mockResolvedValueOnce({ ...domain, phase: 'provisioning', ready: false })
    await render()
    await click('Manage app.example.com')
    await click('Configured, verify')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'The certificate authorization CNAME is missing or does not match.',
    )
    expect(document.querySelectorAll('[aria-label^="Copy name for"]')).toHaveLength(3)
    expect(feedback.error).toHaveBeenCalled()
    expect(feedback.success).not.toHaveBeenCalled()
    vi.useFakeTimers()
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.verifyCustomDomain).toHaveBeenCalledTimes(1)
      expect(api.advanceCustomDomain).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    await click('Configured, verify')
    expect(api.verifyCustomDomain).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each([
    ['unknown', 'Certificate submission is not yet confirmed. Return later to check progress.'],
    ['not_submitted', 'The certificate request has not been submitted. Return later to check progress.'],
  ] as const)(
    'closes after DNS confirmation but explains %s certificate submission',
    async (submissionStatus, description) => {
      response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
      api.verifyCustomDomain.mockResolvedValue({ ...domain, phase: 'provisioning', ready: false, submissionStatus })
      await render()
      await click('Manage app.example.com')
      await click('Configured, verify')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(feedback.success).toHaveBeenCalledWith('DNS verification passed.', { description })
    },
  )

  it('keeps an unconfirmed response open without claiming verification passed', async () => {
    response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
    await render()
    await click('Manage app.example.com')
    await click('Configured, verify')
    expect(button('Configured, verify').disabled).toBe(false)
    expect(feedback.success).not.toHaveBeenCalled()
    expect(feedback.info).toHaveBeenCalledWith('DNS verification is still pending. Please try again.')
  })

  it('keeps transport errors open for manual retry', async () => {
    response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
    api.verifyCustomDomain.mockRejectedValueOnce(new Error('Request timed out'))
    await render()
    await click('Manage app.example.com')
    await click('Configured, verify')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Request timed out')
    expect(button('Configured, verify').disabled).toBe(false)
    expect(feedback.success).not.toHaveBeenCalled()
    expect(api.verifyCustomDomain).toHaveBeenCalledTimes(1)
  })

  it('does not automatically resume preparation after an incomplete create response', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    response.domains = []
    api.createCustomDomain.mockImplementation(async () => {
      const draft = {
        ...domain,
        phase: 'pending_verification' as const,
        ready: false,
        confirmed: false,
        dnsRecords: [],
      }
      response.domains = [draft]
      return draft
    })
    await render()
    await click('Add custom domain')
    input('Custom hostname', 'app.example.com')
    vi.useFakeTimers()
    try {
      await act(async () => button('Get DNS configuration').click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.prepareCustomDomain).not.toHaveBeenCalled()
      expect(api.verifyCustomDomain).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    expect(button('Continue getting DNS configuration')).toBeDefined()
  })

  it('shows the verification result without waiting for the held-domain refresh', async () => {
    response.domains = [{ ...domain, phase: 'pending_certificate_dns', ready: false, confirmed: false }]
    api.verifyCustomDomain.mockResolvedValue({ ...domain, phase: 'provisioning', ready: false })
    const heldRead = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise(() => {}))
    const observer = new QueryObserver(client, { queryKey: queryKeys.domains.list('org-1'), queryFn: heldRead })
    const unsubscribe = observer.subscribe(() => {})
    try {
      await render()
      await click('Manage app.example.com')
      await click('Configured, verify')
      expect(heldRead).toHaveBeenCalledTimes(2)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(feedback.success).toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
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

  it('does not automatically advance a confirmed dialog while visible or hidden', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await render()
    vi.useFakeTimers()
    try {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_050)
      })
      expect(api.advanceCustomDomain).not.toHaveBeenCalled()
      expect(api.verifyCustomDomain).not.toHaveBeenCalled()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(api.advanceCustomDomain).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    }
  })

  it('distinguishes the certificate CNAME from traffic DNS', async () => {
    response.domains = [{ ...domain, phase: 'provisioning', ready: false }]
    await render()
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage app.example.com"]')!.click())
    const text = document.querySelector('[role="dialog"]')!.textContent
    expect(text).toContain('Certificate authorization')
    expect(text).toContain('Traffic routing')
    expect(document.querySelector('[aria-label="Copy name for Certificate authorization"]')).not.toBeNull()
    expect(text).toContain('do not replace the traffic CNAME')
  })

  it.each(['certificate_provisioning_failed', 'certificate_renewal_failed'])(
    'uses provider-neutral wording for %s',
    async (errorCode) => {
      response.domains = [
        {
          ...domain,
          phase: errorCode === 'certificate_renewal_failed' ? 'ready' : 'provisioning',
          ready: errorCode === 'certificate_renewal_failed',
          errorCode,
        },
      ]
      await render()
      await click('Manage app.example.com')
      const text = document.querySelector('[role="dialog"]')!.textContent
      expect(text).not.toContain('Google')
      expect(text).not.toContain('pki.goog')
      expect(text).not.toContain('one hour')
      expect(text).toContain('support@boxlite.ai')
    },
  )

  it.each(['pending', 'failed', 'ready'])(
    'retries failed HTTPS once and shows the returned %s state',
    async (outcome) => {
      response = {
        ...response,
        domains: [{ ...domain, ready: false, phase: 'provisioning', errorCode: 'certificate_provisioning_failed' }],
      }
      let complete!: (value: CustomDomain) => void
      api.advanceCustomDomain.mockImplementation(
        () =>
          new Promise<CustomDomain>((resolve) => {
            complete = resolve
          }),
      )
      await render()
      await click('Manage app.example.com')
      expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('HTTPS is being enabled')
      expect(document.querySelector('a[href="mailto:support@boxlite.ai"]')).not.toBeNull()
      const retry = button('Retry')
      expect(retry).toBeDefined()
      await act(async () => retry.click())
      await settle()
      expect(button('Retrying…').disabled).toBe(true)
      await act(async () => retry.click())
      expect(api.advanceCustomDomain).toHaveBeenCalledTimes(1)
      expect(api.advanceCustomDomain).toHaveBeenCalledWith('org-1', domain.id)
      const result: CustomDomain =
        outcome === 'ready'
          ? domain
          : {
              ...domain,
              ready: false,
              phase: 'provisioning',
              errorCode: outcome === 'failed' ? 'certificate_provisioning_failed' : null,
            }
      await act(async () => complete(result))
      await settle()
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      if (outcome === 'failed') {
        expect(button('Retry').disabled).toBe(false)
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('If retrying does not help, contact')
        expect(feedback.error).toHaveBeenCalledWith('HTTPS setup still needs attention.')
      } else {
        expect(button('Retry')).toBeUndefined()
        if (outcome === 'ready') expect(feedback.success).toHaveBeenCalledWith('HTTPS is ready.')
        else expect(feedback.info).toHaveBeenCalledWith('HTTPS setup is in progress. You can check back later.')
      }
      expect(api.verifyCustomDomain).not.toHaveBeenCalled()
      expect(api.createCustomDomain).not.toHaveBeenCalled()
    },
  )

  it('keeps HTTPS Retry and support guidance after a transport failure', async () => {
    response = {
      ...response,
      domains: [{ ...domain, ready: false, phase: 'provisioning', errorCode: 'certificate_provisioning_failed' }],
    }
    api.advanceCustomDomain.mockRejectedValueOnce(new Error('Network Error'))
    await render()
    await click('Manage app.example.com')
    expect(button('Retry')).toBeDefined()
    await click('Retry')
    expect(button('Retry').disabled).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Could not retry HTTPS setup.')
    expect(document.querySelector('a[href="mailto:support@boxlite.ai"]')).not.toBeNull()
    expect(api.advanceCustomDomain).toHaveBeenCalledTimes(1)
    expect(feedback.success).not.toHaveBeenCalled()
  })

  it('disables HTTPS Retry when a subscription is required', async () => {
    response = {
      ...response,
      subscription: 'required',
      domains: [{ ...domain, ready: false, phase: 'provisioning', errorCode: 'certificate_provisioning_failed' }],
    }
    await render()
    await click('Manage app.example.com')
    expect(button('Retry')).toBeDefined()
    expect(button('Retry').disabled).toBe(true)
    await act(async () => button('Retry').click())
    expect(api.advanceCustomDomain).not.toHaveBeenCalled()
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
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(
      'disconnects any previous organization',
    )
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
