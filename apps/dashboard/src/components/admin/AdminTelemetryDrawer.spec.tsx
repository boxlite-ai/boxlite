// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AdminBox } from './adminHelpers'
import { createBoxDiagnoseTarget } from './adminDiagnoseTarget'
import AdminTelemetryDrawer from './AdminTelemetryDrawer'

const investigateMock = vi.hoisted(() => {
  const createData = () => ({
    resource: { type: 'box', title: 'Box box-test-001', subtitle: 'Brian Luo · org-test' },
    sources: [
      { source: 'clickhouse', state: 'available', count: 2 },
      { source: 'cloudwatch', state: 'missing', message: 'No stdout logs matched this box.' },
    ],
    externalLinks: {
      clickstack: {
        configured: true,
        dashboardUrl: 'https://hyperdx.clickhouse.cloud/dashboards/dashboard-1',
        logsUrl: 'https://hyperdx.clickhouse.cloud/search',
        tracesUrl: 'https://hyperdx.clickhouse.cloud/search',
        metricsUrl: 'https://hyperdx.clickhouse.cloud/chart',
        missingSources: ['logs'],
        message: 'ClickStack is reachable, but logs source id needs to be configured for one-click queries',
        sourceSetup: [
          {
            kind: 'logs',
            envVar: 'ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID',
            name: 'BoxLite Logs',
            dataType: 'Log',
            database: 'otel',
            table: 'otel_logs',
            timestampColumn: 'Timestamp',
          },
        ],
      },
    },
    commands: {
      api: '/admin/observability/investigate?boxId=box-test-001',
      aiAgentPrompt: 'Use the BoxLite Admin API with X-BoxLite-Source=agent.',
    },
    operations: [],
    timeline: [],
  })

  return {
    createData,
    data: createData(),
    refetch: vi.fn(),
  }
})

vi.mock('@/hooks/useAdminObservability', () => ({
  useAdminObservabilityInvestigate: () => ({
    data: investigateMock.data,
    isLoading: false,
    isError: false,
    refetch: investigateMock.refetch,
  }),
}))

const box: AdminBox = {
  id: 'box-test-001',
  organizationId: 'org-test',
  state: 'started',
  runnerId: 'runner-test-001',
  cpu: 2,
  memoryGiB: 4,
  createdAt: '2026-05-24T09:10:00.000Z',
  owner: {
    name: 'Brian Luo',
    email: 'brian@example.com',
    orgName: 'personal',
    personal: true,
  },
}

describe('AdminTelemetryDrawer', () => {
  let root: Root | null = null

  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    investigateMock.data = investigateMock.createData()
    investigateMock.refetch.mockClear()
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  it('shows box diagnosis evidence and agent entry points', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <AdminTelemetryDrawer
            target={createBoxDiagnoseTarget(box)}
            open
            onOpenChange={vi.fn()}
            onRecover={vi.fn()}
            onJumpToRunner={vi.fn()}
          />
        </MemoryRouter>,
      )
    })

    const text = document.body.textContent ?? ''

    expect(text).toContain('Diagnose box')
    expect(text).toContain('Evidence sources')
    expect(text).toContain('Human deep links')
    expect(text).toContain('Dashboard')
    expect(text).toContain('ClickStack is reachable, but logs source id needs to be configured')
    expect(text).toContain('ClickStack source setup')
    expect(text).toContain('BoxLite Logs')
    expect(text).toContain('ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID')
    expect(text).toContain('Admin API and AI Agent')
    expect(text).toContain('Operations')
    expect(text).toContain('Timeline')
  })

  it('makes the diagnose query window explicit to avoid empty-equals-no-data ambiguity', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <AdminTelemetryDrawer
            target={createBoxDiagnoseTarget(box)}
            open
            onOpenChange={vi.fn()}
            onRecover={vi.fn()}
            onJumpToRunner={vi.fn()}
          />
        </MemoryRouter>,
      )
    })

    const note = document.querySelector('[data-testid="diagnose-window-note"]')
    expect(note?.textContent).toContain('Window:')
    expect(note?.textContent).toContain('last 1h')
  })

  it('renders the ClickStack dashboard as a first-class human link', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <AdminTelemetryDrawer
            target={createBoxDiagnoseTarget(box)}
            open
            onOpenChange={vi.fn()}
            onRecover={vi.fn()}
            onJumpToRunner={vi.fn()}
          />
        </MemoryRouter>,
      )
    })

    const dashboardAnchor = Array.from(document.querySelectorAll('a')).find((anchor) =>
      anchor.textContent?.includes('Dashboard'),
    )

    expect(dashboardAnchor?.getAttribute('href')).toBe('https://hyperdx.clickhouse.cloud/dashboards/dashboard-1')
  })

  it('disables ClickStack links when a source URL is missing', () => {
    investigateMock.data.externalLinks.clickstack.logsUrl = undefined
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <AdminTelemetryDrawer
            target={createBoxDiagnoseTarget(box)}
            open
            onOpenChange={vi.fn()}
            onRecover={vi.fn()}
            onJumpToRunner={vi.fn()}
          />
        </MemoryRouter>,
      )
    })

    const logsButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Logs'),
    )
    const logAnchors = Array.from(document.querySelectorAll('a')).filter((anchor) =>
      anchor.textContent?.includes('Logs'),
    )

    expect(logsButton?.hasAttribute('disabled')).toBe(true)
    expect(logAnchors).toHaveLength(0)
    expect(document.body.textContent ?? '').toContain('ADMIN_OBSERVABILITY_CLICKSTACK_LOG_SOURCE_ID')
  })
})
