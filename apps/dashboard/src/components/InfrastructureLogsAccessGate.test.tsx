// @vitest-environment jsdom
/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InfrastructureLogsAccessGate } from './InfrastructureLogsAccessGate'

const mocks = vi.hoisted(() => ({
  access: { data: undefined as { canRead: boolean } | undefined, isPending: false },
}))

vi.mock('@/hooks/useInfrastructureLogs', () => ({
  useInfrastructureLogsAccess: () => mocks.access,
}))

describe('InfrastructureLogsAccessGate', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    mocks.access = { data: undefined, isPending: false }
  })

  function renderGate() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        <InfrastructureLogsAccessGate denied={<span>denied</span>} pending={<span>pending</span>}>
          <span>logs</span>
        </InfrastructureLogsAccessGate>,
      )
    })
  }

  it('renders infrastructure logs for an administrator', () => {
    mocks.access = { data: { canRead: true }, isPending: false }
    renderGate()

    expect(document.body.textContent).toBe('logs')
  })

  it('renders the denied fallback for a non-administrator', () => {
    mocks.access = { data: { canRead: false }, isPending: false }
    renderGate()

    expect(document.body.textContent).toBe('denied')
  })

  it('does not expose protected content while access is loading', () => {
    mocks.access = { data: undefined, isPending: true }
    renderGate()

    expect(document.body.textContent).toBe('pending')
  })
})
