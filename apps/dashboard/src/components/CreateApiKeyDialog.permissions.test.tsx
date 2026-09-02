// @vitest-environment jsdom
/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'
import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateApiKeyDialog } from './CreateApiKeyDialog'

const createApiKeyMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/mutations/useCreateApiKeyMutation', () => ({
  useCreateApiKeyMutation: () => ({ mutateAsync: createApiKeyMock }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// jsdom ships neither of these; Radix's dialog/checkbox primitives touch both.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}

const AVAILABLE = CREATE_API_KEY_PERMISSIONS_GROUPS.flatMap((group) => group.permissions)

async function typeNameAndSubmit(name: string) {
  await act(async () => {
    typeIntoNameField(name)
  })
  await act(async () => {
    document.querySelector<HTMLFormElement>('form#create-api-key-form')?.requestSubmit()
  })
  await settleSubmitFlow()
}

/** React tracks the input's value setter, so a plain assignment would not fire onChange. */
function typeIntoNameField(value: string) {
  const field = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!field || !nativeSetter) {
    throw new Error('name field not rendered')
  }
  nativeSetter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Settle the submit flow. Everything it awaits — the mocked mutation and the
 * state updates behind it — resolves on the microtask queue, so draining it
 * inside act() is deterministic; no scheduler timing is involved.
 */
async function settleSubmitFlow() {
  await act(async () => {
    await createApiKeyMock.mock.results.at(-1)?.value
  })
}

/**
 * Every per-permission checkbox, keyed by "<Group> <Action>" the way an operator
 * reads the row. The group-level checkbox is skipped: its caption repeats the
 * group heading, so group and action come out equal.
 *
 * The row caption is the LAST span in the label — the first one belongs to the
 * Radix checkbox indicator and is always empty.
 */
function permissionRows(): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  document.querySelectorAll('label').forEach((label) => {
    const group = label.closest('div.flex.flex-col')?.querySelector('span.font-semibold')?.textContent
    const action = [...label.querySelectorAll('span')].pop()?.textContent
    const control = label.querySelector('[role="checkbox"]')
    if (group && action && control && group !== action) {
      rows.set(`${group} ${action}`, control as HTMLElement)
    }
  })
  return rows
}

describe('CreateApiKeyDialog permissions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    createApiKeyMock.mockReset().mockResolvedValue({ value: 'blk_live_stub' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(
        <CreateApiKeyDialog availablePermissions={AVAILABLE} apiUrl="http://localhost" organizationId="org-1" />,
      )
    })
    // The form only exists once the dialog is opened.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Create Key"]')?.click()
    })
    await settleSubmitFlow()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('offers read, write and delete for volumes as separate options', () => {
    const rows = permissionRows()

    expect([...rows.keys()]).toEqual(expect.arrayContaining(['Volumes Read', 'Volumes Write', 'Volumes Delete']))
  })

  it('does not ask about box access, which every key carries anyway', () => {
    const rows = permissionRows()

    expect([...rows.keys()].filter((label) => label.startsWith('Boxes'))).toEqual([])
  })

  it('submits box access alongside the volume permissions left ticked', async () => {
    await typeNameAndSubmit('volumes-and-boxes')

    expect(createApiKeyMock).toHaveBeenCalledTimes(1)
    expect(createApiKeyMock.mock.calls[0][0].permissions).toEqual([
      CreateApiKeyPermissionsEnum.WRITE_BOXES,
      CreateApiKeyPermissionsEnum.DELETE_BOXES,
      CreateApiKeyPermissionsEnum.READ_VOLUMES,
      CreateApiKeyPermissionsEnum.WRITE_VOLUMES,
      CreateApiKeyPermissionsEnum.DELETE_VOLUMES,
    ])
  })

  it('still issues a usable key when every optional permission is unticked', async () => {
    const rows = permissionRows()

    await act(async () => {
      rows.get('Volumes Read')?.click()
      rows.get('Volumes Write')?.click()
      rows.get('Volumes Delete')?.click()
    })
    await typeNameAndSubmit('boxes-only')

    expect(createApiKeyMock.mock.calls[0][0].permissions).toEqual([
      CreateApiKeyPermissionsEnum.WRITE_BOXES,
      CreateApiKeyPermissionsEnum.DELETE_BOXES,
    ])
  })
})
