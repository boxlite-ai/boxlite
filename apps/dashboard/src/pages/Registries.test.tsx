// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Registries from './Registries'

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const PASSWORD = 'ghp_not-a-real-token'

const state = vi.hoisted(() => ({ credentials: [] as unknown[], listError: null as unknown }))
const mocks = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn(), reset: vi.fn(), handleApiError: vi.fn() }))

vi.mock('@/lib/error-handling', () => ({ handleApiError: mocks.handleApiError }))

vi.mock('@/hooks/queries/useRegistriesQuery', () => ({
  useRegistriesQuery: () => ({ data: state.credentials, error: state.listError }),
}))
vi.mock('@/hooks/mutations/useRegistryMutations', () => ({
  useCreateRegistryMutation: () => ({ mutateAsync: mocks.create, reset: mocks.reset, isPending: false }),
  useDeleteRegistryMutation: () => ({ mutateAsync: mocks.remove, isPending: false }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserHasPermission: () => true,
  }),
}))

describe('the registries page', () => {
  let root: Root | null = null
  let host: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    state.credentials = [
      {
        id: 'credential-1',
        kind: 'basic',
        registryHost: 'ghcr.io',
        repositoryPrefix: 'acme/',
        username: 'acme-bot',
        createdBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    mocks.create.mockReset().mockResolvedValue({})
    mocks.remove.mockReset().mockResolvedValue(undefined)
    mocks.handleApiError.mockReset()
    mocks.reset.mockReset()
    state.listError = null
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root?.render(<Registries />))
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  const open = () => {
    const add = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add login')
    act(() => add?.click())
  }
  const field = (id: string) => document.getElementById(id) as HTMLInputElement

  it('lists a login by where it applies and who it logs in as', () => {
    expect(host.textContent).toContain('ghcr.io')
    expect(host.textContent).toContain('acme/')
    expect(host.textContent).toContain('acme-bot')
  })

  it('takes the password in a masked field, and sends it only in the create', async () => {
    open()
    expect(field('registry-password').type).toBe('password')

    act(() => {
      typeInto(field('registry-username'), 'acme-bot')
      typeInto(field('registry-password'), PASSWORD)
    })
    await act(async () => {
      field('registry-password').form?.requestSubmit()
    })

    expect(mocks.create).toHaveBeenCalledWith({
      credential: { registryHost: 'ghcr.io', repositoryPrefix: '', username: 'acme-bot', password: PASSWORD },
      organizationId: 'org-1',
    })
    // Saved, and the form holding it is gone, and so is the mutation's copy.
    expect(document.getElementById('registry-password')).toBeNull()
    expect(mocks.reset).toHaveBeenCalled()
  })

  it('forgets a typed password when the dialog is closed without saving', () => {
    open()
    act(() => typeInto(field('registry-password'), PASSWORD))

    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')
    act(() => cancel?.click())
    open()

    expect(field('registry-password').value).toBe('')
  })

  // Container Registry serves the same images from a host per region, and each
  // takes the same service account key.
  it.each(['gcr.io', 'us.gcr.io', 'eu.gcr.io', 'asia.gcr.io'])(
    'warns about service account keys once %s is chosen',
    (host) => {
      open()
      const registry = document.getElementById('registry-host') as HTMLSelectElement
      expect(document.body.textContent).not.toContain('service account keys')

      act(() => {
        registry.value = host
        registry.dispatchEvent(new Event('change', { bubbles: true }))
      })

      expect(registry.value).toBe(host)
      expect(document.body.textContent).toContain('service account keys')
    },
  )

  it('shows why a login could not be removed, which names the boxes still pulling', async () => {
    const refusal = new Error('cannot be removed while 1 box(es) pull through it: a1b2c3')
    mocks.remove.mockRejectedValue(refusal)
    const trash = document.querySelector('button[title="Remove the login for ghcr.io"]') as HTMLButtonElement
    act(() => trash.click())

    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Remove')
    await act(async () => confirm?.click())

    expect(mocks.remove).toHaveBeenCalledWith({ id: 'credential-1', organizationId: 'org-1' })
    expect(mocks.handleApiError).toHaveBeenCalledWith(refusal, 'Failed to remove the login for ghcr.io')
  })

  it('reports a list that failed rather than showing an empty one', () => {
    const failure = new Error('403')
    state.credentials = []
    state.listError = failure
    act(() => root?.render(<Registries />))

    expect(mocks.handleApiError).toHaveBeenCalledWith(failure, 'Failed to fetch registry logins')
    expect(host.textContent).toContain('could not be loaded')
    expect(host.textContent).not.toContain('No logins yet')
  })
})
