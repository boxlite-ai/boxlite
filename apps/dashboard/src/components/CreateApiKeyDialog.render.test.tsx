// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateApiKeyPermissionsEnum } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateApiKeyDialog } from './CreateApiKeyDialog'

const mocks = vi.hoisted(() => ({ create: vi.fn(), writeText: vi.fn() }))
vi.mock('@/hooks/mutations/useCreateApiKeyMutation', () => ({
  useCreateApiKeyMutation: () => ({ mutateAsync: mocks.create }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let root: Root

/** Finds a rendered action by its visible label, failing if the expected control is absent. */
function button(label: string) {
  const element = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!element) throw new Error(`Missing button: ${label}`)
  return element
}

/** Opens the real dialog through its trigger, with permissions supplied by the scenario. */
async function renderDialog(permissions = [CreateApiKeyPermissionsEnum.WRITE_BOXES]) {
  await act(async () => {
    root.render(
      <CreateApiKeyDialog
        organizationId="org-1"
        apiUrl="https://api.example.test"
        availablePermissions={permissions}
      />,
    )
  })
  await act(async () => button('New API key').click())
}

async function enterName() {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  agent-key  ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.create.mockReset().mockResolvedValue({ value: 'boxlite_test_key' })
  mocks.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.writeText } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('CreateApiKeyDialog shared button interactions', () => {
  it('submits the external form once, copies the returned key, and closes with Done', async () => {
    await renderDialog()
    expect(button('Create API key').disabled).toBe(true)
    await enterName()

    let finishCreate!: (result: { value: string }) => void
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = resolve
        }),
    )
    await act(async () => button('Create API key').click())
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-1',
      name: 'agent-key',
      permissions: [CreateApiKeyPermissionsEnum.WRITE_BOXES],
      expiresAt: null,
    })
    expect(button('Creating…').disabled).toBe(true)
    await act(async () => button('Creating…').click())
    expect(mocks.create).toHaveBeenCalledTimes(1)

    await act(async () => finishCreate({ value: 'boxlite_test_key' }))
    await act(async () => button('Copy').click())
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('boxlite_test_key')
    expect(button('Copied')).toBeDefined()

    await act(async () => button('Done').click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes an unfinished form without creating a key', async () => {
    await renderDialog()
    await enterName()
    await act(async () => button('Close').click())

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps creation disabled when no permissions are available', async () => {
    await renderDialog([])
    await enterName()
    expect(button('Create API key').disabled).toBe(true)
    await act(async () => button('Create API key').click())
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
