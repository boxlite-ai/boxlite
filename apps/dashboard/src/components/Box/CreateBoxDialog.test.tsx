// @vitest-environment jsdom
/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateBoxDialog, resolvePerBoxLimits } from './CreateBoxDialog'

// Mutable org returned by the mocked hook; each test sets `state.org`.
const state = vi.hoisted(() => ({ org: null as unknown }))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: state.org }),
}))
vi.mock('@/hooks/mutations/useCreateBoxMutation', () => ({
  useCreateBoxMutation: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/queries/useBillingPricingQuery', () => ({
  useBillingPricingQuery: () => ({
    data: {
      version: 1,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      cpuRateCentsPerHour: '5.04',
      memRateCentsPerHour: '1.62',
      diskRateCentsPerHour: '0.0108',
      gpuRateCentsPerHour: '0',
    },
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => vi.fn() }
})

function makeOrg(over: Record<string, unknown>) {
  return { id: 'org-1', name: 'Org', ...over }
}

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('resolvePerBoxLimits', () => {
  it('uses the organization per-box maxima when they are positive', () => {
    const limits = resolvePerBoxLimits(makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 }))
    expect(limits).toEqual({ cpu: 4, memory: 8, disk: 10 })
  })

  it('leaves a resource uncapped when a max is unset (<= 0) — backend treats <=0 as unlimited', () => {
    const limits = resolvePerBoxLimits(makeOrg({ maxCpuPerBox: 0, maxMemoryPerBox: undefined, maxDiskPerBox: -1 }))
    expect(limits).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
  })

  it('leaves resources uncapped when no organization is loaded', () => {
    expect(resolvePerBoxLimits(null)).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
    expect(resolvePerBoxLimits(undefined)).toEqual({ cpu: undefined, memory: undefined, disk: undefined })
  })
})

describe('CreateBoxDialog per-org resource cap', () => {
  let root: Root | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.org = makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 10 })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function renderOpen() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await rerenderOpen(host)
    // Reveal the CPU/Memory/Disk steppers (advanced options are collapsed by default).
    const advanced = [...document.querySelectorAll('button')].find((b) => /Advanced Options/i.test(b.textContent ?? ''))
    await act(async () => advanced?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
  }

  async function rerenderOpen(
    host = document.body.firstElementChild ?? document.body.appendChild(document.createElement('div')),
  ) {
    await act(async () => {
      root ??= createRoot(host)
      root.render(<CreateBoxDialog open onOpenChange={() => {}} />)
    })
    await flush()
  }

  function cpuInput() {
    return document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')[0]
  }

  function nameInput() {
    return document.querySelector<HTMLInputElement>('input[placeholder="my-new-box"]')
  }

  it('clamps an over-max CPU input to the org maximum and shows a red contact-support hint', async () => {
    await renderOpen()
    const input = cpuInput()
    expect(input).toBeTruthy()

    await act(async () => typeInto(input, '50'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    // auto-corrected to the org max (4), not any dashboard-local ceiling.
    expect(input.value).toBe('4')
    // the amber cap note names the capped resource + its max and the support mailbox
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/CPU\s*4\s*vCPU/)
    const mailto = document.querySelector('a[href^="mailto:support@boxlite.ai"]')
    expect(mailto).toBeTruthy()
  })

  it('opens with the default values already clamped to the org max (no over-limit initial state)', async () => {
    // Org caps Disk at 3 GiB — tighter than the built-in DEFAULTS.disk = 10.
    state.org = makeOrg({ maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 3 })
    await renderOpen()
    const inputs = document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')
    // Disk (the third stepper) must open at 3, NOT the DEFAULTS.disk of 10.
    expect(inputs[2].value).toBe('3')
    // CPU / Memory defaults (1 each) are already under the caps — untouched.
    expect(inputs[0].value).toBe('1')
    expect(inputs[1].value).toBe('1')
  })

  it('pins the visible input at the org max the moment the typed value would overshoot (before any blur)', async () => {
    await renderOpen()
    const input = cpuInput()

    // No blur / focusout — this asserts the keystroke-time behaviour, which is
    // the fix for "the box still shows 123123 even with the amber note up".
    await act(async () => typeInto(input, '123123'))
    await flush()
    expect(input.value).toBe('4')
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/CPU\s*4\s*vCPU/)
  })

  it('does not pin the input to a dashboard-local ceiling when the org max is unset', async () => {
    state.org = makeOrg({ maxCpuPerBox: 0, maxMemoryPerBox: undefined, maxDiskPerBox: -1 })
    await renderOpen()
    const input = cpuInput()

    await act(async () => typeInto(input, '123123'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    expect(input.value).toBe('123123')
    expect(document.body.textContent).not.toContain('support@boxlite.ai')
  })

  it('preserves open form state when an org change only tightens resource caps', async () => {
    await renderOpen()
    const name = nameInput()
    const input = cpuInput()

    expect(name).toBeTruthy()
    if (!name) throw new Error('expected name input to be rendered')
    await act(async () => typeInto(name, 'kept-name'))
    await act(async () => typeInto(input, '4'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    state.org = makeOrg({ maxCpuPerBox: 2, maxMemoryPerBox: 8, maxDiskPerBox: 10 })
    await rerenderOpen()

    expect(nameInput()?.value).toBe('kept-name')
    expect(document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]').length).toBe(3)
    expect(cpuInput().value).toBe('2')
    expect(document.body.textContent).toMatch(/CPU\s*2\s*vCPU/)
  })

  it('caps each of the three resource fields independently against its own max', async () => {
    await renderOpen()
    const inputs = document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')
    expect(inputs.length).toBe(3)

    for (const input of Array.from(inputs)) {
      await act(async () => typeInto(input, '999999'))
      await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
      await flush()
    }

    // Org limits from beforeEach: cpu 4, memory 8, disk 10
    expect(inputs[0].value).toBe('4')
    expect(inputs[1].value).toBe('8')
    expect(inputs[2].value).toBe('10')

    const note = document.body.textContent ?? ''
    expect(note).toMatch(/CPU\s*4\s*vCPU/)
    expect(note).toMatch(/Memory\s*8\s*GiB/)
    expect(note).toMatch(/Disk\s*10\s*GiB/)
  })

  it('clears the hint once the value is brought back under the max', async () => {
    await renderOpen()
    const input = cpuInput()
    await act(async () => typeInto(input, '50'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()
    expect(document.body.textContent).toContain('support@boxlite.ai')

    const decrease = document.querySelector<HTMLButtonElement>('button[aria-label="decrease"]')
    await act(async () => decrease?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(input.value).toBe('3')
    expect(document.body.textContent).not.toContain('support@boxlite.ai')
  })

  it('shows a live hourly estimate from the current pricing version', async () => {
    await renderOpen()

    expect(document.body.textContent).toContain('$0.06768')
    const increaseCpu = document.querySelectorAll<HTMLButtonElement>('button[aria-label="increase"]')[0]
    await act(async () => increaseCpu.click())
    await flush()

    expect(document.body.textContent).toContain('$0.11808')
    expect(document.body.textContent).toContain('Pricing v1')
    expect(document.body.textContent).not.toContain('free in preview')
  })
})
