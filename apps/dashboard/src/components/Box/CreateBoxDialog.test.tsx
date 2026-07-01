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

  it('falls back to the built-in ceiling when a max is unset (<= 0) — backend treats <=0 as unlimited', () => {
    const limits = resolvePerBoxLimits(makeOrg({ maxCpuPerBox: 0, maxMemoryPerBox: undefined, maxDiskPerBox: -1 }))
    expect(limits).toEqual({ cpu: 8, memory: 32, disk: 50 })
  })

  it('falls back entirely when no organization is loaded', () => {
    expect(resolvePerBoxLimits(null)).toEqual({ cpu: 8, memory: 32, disk: 50 })
    expect(resolvePerBoxLimits(undefined)).toEqual({ cpu: 8, memory: 32, disk: 50 })
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
    await act(async () => {
      root = createRoot(host)
      root.render(<CreateBoxDialog open onOpenChange={() => {}} />)
    })
    await flush()
    // Reveal the CPU/Memory/Disk steppers (advanced options are collapsed by default).
    const advanced = [...document.querySelectorAll('button')].find((b) => /Advanced Options/i.test(b.textContent ?? ''))
    await act(async () => advanced?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
  }

  function cpuInput() {
    return document.querySelectorAll<HTMLInputElement>('input[aria-label="value"]')[0]
  }

  it('clamps an over-max CPU input to the org maximum and shows a red contact-support hint', async () => {
    await renderOpen()
    const input = cpuInput()
    expect(input).toBeTruthy()

    await act(async () => typeInto(input, '50'))
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await flush()

    // auto-corrected to the org max (4), NOT the built-in ceiling (8)
    expect(input.value).toBe('4')
    // red hint appears with the quota and the support mailbox
    expect(document.body.textContent).toContain('support@boxlite.ai')
    expect(document.body.textContent).toMatch(/Max\s*4/)
    const mailto = document.querySelector('a[href^="mailto:support@boxlite.ai"]')
    expect(mailto).toBeTruthy()
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
})
