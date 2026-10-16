// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationInvitation, OrganizationUser } from '@boxlite-ai/api-client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrganizationMemberTable } from './OrganizationMemberTable'

// The creator's membership in their own personal organization, and an invitee's.
const members = [
  { userId: 'user-1', email: 'creator@example.com', role: 'owner', isDefaultForUser: true },
  { userId: 'user-2', email: 'invitee@example.com', role: 'owner', isDefaultForUser: false },
] as OrganizationUser[]

const invitations = [
  {
    id: 'inv-1',
    email: 'pending@example.com',
    role: 'owner',
    status: 'pending',
    invitedBy: 'creator@example.com',
    expiresAt: new Date(Date.now() + 86_400_000),
  },
] as OrganizationInvitation[]
const onCancelInvitation = vi.fn(async () => true)
const onResendInvitation = vi.fn(async () => true)

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
    onCancelInvitation.mockReset().mockResolvedValue(true)
    onResendInvitation.mockReset().mockResolvedValue(true)
  })

  function renderTable(ownerMode = true, pending = invitations, loading = false) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <OrganizationMemberTable
          data={members}
          loadingData={false}
          onRemoveMember={vi.fn(async () => true)}
          loadingMemberAction={{ 'user-2': loading }}
          ownerMode={ownerMode}
          {...{
            invitations: pending,
            onCancelInvitation,
            onResendInvitation,
            loadingInvitationAction: { 'inv-1': loading },
          }}
        />,
      )
    })
  }

  function rowFor(email: string): HTMLTableRowElement {
    const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(email))
    expect(row).toBeTruthy()
    return row as HTMLTableRowElement
  }

  it.each(['invitee@example.com', 'pending@example.com'])(
    'blocks keyboard actions while %s is loading',
    async (email) => {
      renderTable(true, invitations, true)
      const trigger = rowFor(email).querySelector('button')
      expect(trigger).not.toBeNull()
      await act(async () => trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      expect(document.querySelector('[role="menuitem"]')).toBeNull()
      expect(trigger?.disabled).toBe(true)
    },
  )

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

  it('combines members and invitations in one table with distinct statuses', () => {
    renderTable()
    expect(document.querySelectorAll('table')).toHaveLength(1)
    expect(rowFor('pending@example.com').textContent).toContain('Invited')
    expect(rowFor('pending@example.com').textContent).toContain('creator@example.com')
    expect(rowFor('invitee@example.com').textContent).toContain('Member')
  })

  it('cancels an invited row and keeps the confirmation open when cancellation fails', async () => {
    onCancelInvitation.mockResolvedValue(false)
    renderTable()
    const trigger = rowFor('pending@example.com').querySelector('button')
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const actions = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(actions.map((action) => action.textContent)).toEqual(['Cancel'])
    await act(async () => actions[0].click())
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Confirm')
        ?.click(),
    )
    expect(onCancelInvitation).toHaveBeenCalledWith('inv-1')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    onCancelInvitation.mockResolvedValue(true)
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Confirm')
        ?.click(),
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers Remove and Resend for expired invitations', async () => {
    renderTable(true, [{ ...invitations[0], expiresAt: new Date(0) }])
    expect(rowFor('pending@example.com').textContent).toContain('Expired')
    const trigger = rowFor('pending@example.com').querySelector('button')
    expect(trigger).not.toBeNull()
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const actions = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(actions.map((action) => action.textContent)).toEqual(['Resend', 'Remove'])
    await act(async () => actions[0].click())
    expect(onResendInvitation).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }))
  })

  it('confirms removal of an expired invitation and preserves the dialog on failure', async () => {
    onCancelInvitation.mockResolvedValue(false)
    renderTable(true, [{ ...invitations[0], expiresAt: new Date(0) }])
    const trigger = rowFor('pending@example.com').querySelector('button')
    expect(trigger).not.toBeNull()
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Remove')
        ?.click(),
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Remove Invitation')
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((item) => item.textContent === 'Remove')
        ?.click(),
    )
    expect(onCancelInvitation).toHaveBeenCalledWith('inv-1')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('hides outgoing invitations and management actions from non-owners', () => {
    renderTable(false)
    expect(document.querySelector('tbody')?.textContent).not.toContain('pending@example.com')
    expect(document.querySelector('tbody button')).toBeNull()
  })
})
