// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import EmailVerify from './EmailVerify'
import { RoutePath } from '@/enums/RoutePath'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  verifyOrganizationEmail: vi.fn(),
  onSelectOrganization: vi.fn(),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ organizationId: 'org-1', email: 'a@b.c', token: 'tok-1' }),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: { verifyOrganizationEmail: mocks.verifyOrganizationEmail } }),
}))

// The provider hands back a NEW onSelectOrganization identity each render: selecting an
// organization sets selectedOrganizationId, which re-creates refreshOrganizationMembers and
// therefore handleSelectOrganization (SelectedOrganizationProvider.tsx:115,148). Re-creating it
// here is what reproduces the dependency change the page sees in production.
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    onSelectOrganization: (...args: unknown[]) => mocks.onSelectOrganization(...args),
  }),
}))

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  mocks.navigate.mockReset()
  mocks.onSelectOrganization.mockReset()
  // A verification token is spendable once, so only the first call succeeds. That is what makes
  // the re-run case below discriminating: cancel the pending redirect and there is no second
  // chance to arm another.
  mocks.verifyOrganizationEmail
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValue(new Error('verification token already used'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function flush() {
  // Two awaits: one for the verify promise, one for the state updates it queues.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EmailVerify', () => {
  it('redirects to billing after verifying, even when the effect re-runs', async () => {
    await act(async () => {
      root.render(<EmailVerify />)
    })
    await flush()

    // A re-render is what a changed onSelectOrganization identity causes. The pending redirect
    // must survive it — clearing the timer in the verify effect's own cleanup cancelled it.
    await act(async () => {
      root.render(<EmailVerify />)
    })
    await flush()

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(mocks.navigate).toHaveBeenCalledWith(RoutePath.BILLING)
  })

  it('does not redirect once the page is gone', async () => {
    await act(async () => {
      root.render(<EmailVerify />)
    })
    await flush()

    act(() => root.unmount())
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(mocks.navigate).not.toHaveBeenCalled()

    // afterEach unmounts too; re-root so that stays valid.
    root = createRoot(container)
  })
})
