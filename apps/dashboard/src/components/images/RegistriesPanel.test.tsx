// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegistriesPanel } from './RegistriesPanel'

// Drive a React controlled input the way a user typing would.
function typeInto(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const PASSWORD = 'ghp_not-a-real-token'

const state = vi.hoisted(() => ({
  credentials: [] as unknown[],
  listError: null as unknown,
  byId: new Map<string, unknown>(),
}))
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  remove: vi.fn(),
  reset: vi.fn(),
  handleApiError: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/lib/error-handling', () => ({ handleApiError: mocks.handleApiError }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))
vi.mock('@/hooks/queries/useRegistriesQuery', () => ({
  useRegistriesQuery: () => ({ data: state.credentials, error: state.listError, isLoading: false }),
}))
vi.mock('@/hooks/queries/useBoxesByImageQuery', () => ({
  useBoxesByImageQuery: () => ({ byId: state.byId }),
}))
vi.mock('@/hooks/mutations/useRegistryMutations', () => ({
  useCreateRegistryMutation: () => ({ mutateAsync: mocks.create, reset: mocks.reset, isPending: false }),
  useDeleteRegistryMutation: () => ({ mutateAsync: mocks.remove, isPending: false }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    organizationMembers: [{ userId: 'user-1', name: 'Chen Ming', email: 'chen@example.com' }],
    authenticatedUserHasPermission: () => true,
  }),
}))

const CREDENTIAL = {
  id: 'credential-1',
  kind: 'basic',
  registryHost: 'ghcr.io',
  repositoryPrefix: 'acme/',
  username: 'acme-bot',
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
}

let root: Root | null = null
let host: HTMLDivElement

async function renderPanel(entry = '/dashboard/images/registries') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(RegistriesPanel))),
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.credentials = [CREDENTIAL]
  state.listError = null
  state.byId = new Map()
  vi.resetAllMocks()
  mocks.create.mockResolvedValue({})
  mocks.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)
const field = (id: string) => document.getElementById(id) as HTMLInputElement
const open = () => act(() => button('Connect a registry')?.click())

async function fillAndSubmit(values: { prefix?: string; username?: string; password?: string }) {
  act(() => {
    if (values.prefix !== undefined) typeInto(field('registry-prefix'), values.prefix)
    typeInto(field('registry-username'), values.username ?? 'acme-bot')
    typeInto(field('registry-password'), values.password ?? PASSWORD)
  })
  await act(async () => field('registry-password').form?.requestSubmit())
}

describe('the credential list', () => {
  it('lists a credential by what it covers, who it pulls as, and who added it', async () => {
    await renderPanel()

    expect(host.textContent).toContain('ghcr.io')
    expect(host.textContent).toContain('acme/*')
    expect(host.textContent).toContain('acme-bot')
    expect(host.textContent).toContain('by Chen Ming')
  })

  it('reports a list that failed rather than showing an empty one', async () => {
    const failure = new Error('403')
    state.credentials = []
    state.listError = failure
    await renderPanel()

    expect(mocks.handleApiError).toHaveBeenCalledWith(failure, 'Failed to fetch registry credentials')
    expect(host.textContent).toContain('could not be loaded')
    expect(host.textContent).not.toContain('No private registry connected')
  })

  // A deploy without a secret store answers 501. That is a state of the
  // environment, not a failure, and there is nothing to connect.
  it('says private registries are off where the deploy does not support them', async () => {
    state.credentials = []
    state.listError = new BoxliteError('Registry credentials are not configured for this deployment')
    await renderPanel()

    expect(host.textContent).toContain('not enabled in this environment')
    expect(button('Connect a registry')).toBeUndefined()
    expect(mocks.handleApiError).not.toHaveBeenCalled()
  })
})

describe('connecting a registry', () => {
  it('takes the secret in a masked field, and sends it only in the create', async () => {
    await renderPanel()
    open()
    expect(field('registry-password').type).toBe('password')

    await fillAndSubmit({})

    expect(mocks.create).toHaveBeenCalledWith({
      credential: { registryHost: 'ghcr.io', repositoryPrefix: '', username: 'acme-bot', password: PASSWORD },
      organizationId: 'org-1',
    })
    expect(document.getElementById('registry-password')).toBeNull()
    expect(mocks.reset).toHaveBeenCalled()
  })

  // The API takes whole path segments ending in a slash; one left off is
  // completed rather than refused.
  it('completes a repository prefix typed without its trailing slash', async () => {
    await renderPanel()
    open()

    act(() => typeInto(field('registry-prefix'), 'acme'))
    expect(host.ownerDocument.body.textContent).toContain('ghcr.io/acme/*')
    await fillAndSubmit({})

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ credential: expect.objectContaining({ repositoryPrefix: 'acme/' }) }),
    )
  })

  it('forgets a typed secret when the dialog is closed without saving', async () => {
    await renderPanel()
    open()
    act(() => typeInto(field('registry-password'), PASSWORD))

    act(() => button('Cancel')?.click())
    open()

    expect(field('registry-password').value).toBe('')
  })

  it('says which credential is in the way of a duplicate, and keeps the form', async () => {
    mocks.create.mockRejectedValue(
      new BoxliteError('A credential for ghcr.io/acme/ already exists; remove it before adding another'),
    )
    await renderPanel()
    open()
    await fillAndSubmit({ prefix: 'acme/' })

    expect(mocks.toastError).toHaveBeenCalledWith('ghcr.io/acme/* already has a credential', expect.anything())
    expect(field('registry-prefix').value).toBe('acme/')
    expect(mocks.reset).not.toHaveBeenCalled()
  })

  it('reports any other failure with the API’s reason', async () => {
    const refusal = new BoxliteError('registry host not allowed')
    mocks.create.mockRejectedValue(refusal)
    await renderPanel()
    open()
    await fillAndSubmit({})

    expect(mocks.handleApiError).toHaveBeenCalledWith(refusal, 'Could not connect ghcr.io')
  })

  // A box whose private pull was refused links here with the registry named,
  // so the form opens on it with that registry's instructions.
  it('opens on the registry a link names, with that registry’s instructions', async () => {
    await renderPanel('/dashboard/images/registries?connect=gcr.io')

    expect(field('registry-username')).not.toBeNull()
    expect(document.body.textContent).toContain('Google Container Registry (gcr.io)')
    expect(document.body.textContent).toContain('oauth2accesstoken')
  })

  it('ignores a link naming a registry the API does not accept', async () => {
    await renderPanel('/dashboard/images/registries?connect=evil.example.com')

    expect(document.getElementById('registry-username')).toBeNull()
  })
})

describe('removing a credential', () => {
  it('removes a confirmed credential and closes the confirmation', async () => {
    await renderPanel()
    act(() =>
      (document.querySelector('button[title="Remove the credential for ghcr.io"]') as HTMLButtonElement).click(),
    )
    await act(async () => button('Remove')?.click())

    expect(mocks.remove).toHaveBeenCalledWith({ id: 'credential-1', organizationId: 'org-1' })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  // The API refuses while boxes pull through the credential and lists them by
  // id; the reader is told which boxes, by name.
  it('names the boxes a refusal lists', async () => {
    state.byId = new Map([['a1b2c3', { id: 'a1b2c3', name: 'agile-otter' }]])
    mocks.remove.mockRejectedValue(
      new BoxliteError('Registry credential credential-1 cannot be removed while 1 box(es) pull through it: a1b2c3'),
    )
    await renderPanel()
    act(() =>
      (document.querySelector('button[title="Remove the credential for ghcr.io"]') as HTMLButtonElement).click(),
    )
    await act(async () => button('Remove')?.click())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Still in use',
      expect.objectContaining({ description: expect.stringContaining('agile-otter') }),
    )
  })
})
