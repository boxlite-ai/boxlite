// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Observability from './Observability'

const mocks = vi.hoisted(() => ({
  logs: vi.fn(() => <div data-testid="logs" />),
  traces: vi.fn(() => <div data-testid="traces" />),
  metrics: vi.fn(() => <div data-testid="metrics" />),
}))

vi.mock('@/components/boxes', () => ({
  BoxLogsTab: (props: unknown) => mocks.logs(props),
  BoxTracesTab: (props: unknown) => mocks.traces(props),
  BoxMetricsTab: (props: unknown) => mocks.metrics(props),
}))

describe('Observability page', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('passes URL-scoped Box and source filters to the tenant log view', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/observability?tab=logs&boxId=box-a&source=runner']}>
          <Observability />
        </MemoryRouter>,
      )
    })

    expect(document.querySelector('[data-testid="logs"]')).not.toBeNull()
    expect(mocks.logs).toHaveBeenCalledWith({ boxId: 'box-a', sources: ['runner'] })
  })

  it('requires an explicit Box before rendering metrics', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/observability?tab=metrics']}>
          <Observability />
        </MemoryRouter>,
      )
    })

    expect(document.body.textContent).toContain('Select a Box')
    expect(mocks.metrics).not.toHaveBeenCalled()
  })
})
