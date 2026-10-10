// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationInvitation } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrganizationInvitationTable } from './OrganizationInvitationTable'

const pending = {
  id: 'inv-1',
  email: 'invitee@example.com',
  status: 'pending',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
} as unknown as OrganizationInvitation

describe('OrganizationInvitationTable', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Pagination asks for the viewport size; jsdom has no matchMedia.
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as never
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  it('offers only cancellation for a pending invitation', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <OrganizationInvitationTable
          data={[pending]}
          loadingData={false}
          onCancelInvitation={vi.fn(async () => true)}
          loadingInvitationAction={{}}
        />,
      )
    })

    const menuTrigger = document.querySelector<HTMLButtonElement>('tbody button')
    // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
    await act(async () =>
      menuTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toEqual(['Cancel'])
  })
})
