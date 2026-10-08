// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationUser } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrganizationMemberTable } from './OrganizationMemberTable'

// The creator's membership in their own personal organization, and an invitee's.
const members = [
  { userId: 'user-1', email: 'creator@example.com', role: 'owner', isDefaultForUser: true },
  { userId: 'user-2', email: 'invitee@example.com', role: 'owner', isDefaultForUser: false },
] as OrganizationUser[]

describe('OrganizationMemberTable', () => {
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

  function renderTable() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <OrganizationMemberTable
          data={members}
          loadingData={false}
          onRemoveMember={vi.fn(async () => true)}
          loadingMemberAction={{}}
          ownerMode
        />,
      )
    })
  }

  function rowFor(email: string): HTMLTableRowElement {
    const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(email))
    expect(row).toBeTruthy()
    return row as HTMLTableRowElement
  }

  it('offers no role or assignment editing to an owner', () => {
    renderTable()

    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).not.toContain('Assignments')
    // A role that can be changed renders as a button; every member is an owner now.
    expect(rowFor('invitee@example.com').querySelector('button:not([aria-haspopup])')).toBeNull()
  })

  it('offers removal for an invitee but not for the creator of this personal organization', async () => {
    renderTable()

    expect(rowFor('creator@example.com').querySelector('button')).toBeNull()

    const menuTrigger = rowFor('invitee@example.com').querySelector<HTMLButtonElement>('button')
    expect(menuTrigger?.textContent).toContain('Open menu')
    // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
    await act(async () =>
      menuTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toEqual(['Remove'])
  })
})
