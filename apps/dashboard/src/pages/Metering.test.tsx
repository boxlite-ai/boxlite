// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Metering from './Metering'

const meteringQueryMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  PageContent: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1', name: 'Acme' },
  }),
}))

vi.mock('@/hooks/queries/useOrganizationMeteringQuery', () => ({
  useOrganizationMeteringQuery: (args: unknown) => meteringQueryMock(args),
}))

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('Metering page', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.clearAllMocks()
    meteringQueryMock.mockReturnValue({
      data: {
        organizationId: 'org-1',
        from: '2026-07-07T23:00:00.000Z',
        to: '2026-07-08T01:00:00.000Z',
        totals: {
          cpuSeconds: 7200,
          memGibSeconds: 14400,
          diskGibSeconds: 108000,
          gpuSeconds: 3600,
        },
        activePeriods: [
          {
            id: 'period-open',
            source: 'box_usage_period',
            boxId: 'box-1',
            organizationId: 'org-1',
            region: 'us',
            startAt: '2026-07-08T00:00:00.000Z',
            endAt: null,
            kind: 'stopped',
            cpu: 0,
            mem: 0,
            disk: 10,
            gpu: 0,
            durationSeconds: 3600,
            active: true,
            actualCpuSeconds: null,
            actualRssAvgBytes: null,
            actualRssPeakBytes: null,
            sampleCount: null,
          },
        ],
        archivedPeriods: [
          {
            id: 'archive-1',
            source: 'box_usage_period_archive',
            sourcePeriodId: 'period-closed',
            boxId: 'box-2',
            organizationId: 'org-1',
            region: 'us',
            startAt: '2026-07-07T23:00:00.000Z',
            endAt: '2026-07-08T00:00:00.000Z',
            kind: 'stopped',
            cpu: 0,
            mem: 0,
            disk: 20,
            gpu: 0,
            durationSeconds: 3600,
            active: false,
            actualCpuSeconds: null,
            actualRssAvgBytes: null,
            actualRssPeakBytes: null,
            sampleCount: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      isFetching: false,
    })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  async function renderMetering() {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(<Metering />)
    })

    await flushReactWork()
  }

  it('renders raw metering totals and period rows', async () => {
    await renderMetering()

    expect(document.body.textContent).toContain('Metering')
    expect(document.body.textContent).toContain('Open ledger periods')
    expect(document.body.textContent).toContain('Closed usage periods')
    expect(document.body.textContent).toContain('Open stopped rows keep metering disk only.')
    expect(document.body.textContent).toContain('disk only')
    expect(document.body.textContent).toContain('2.00 vCPU·hr')
    expect(document.body.textContent).toContain('4.00 GiB·hr')
    expect(document.body.textContent).toContain('box-1')
    expect(document.body.textContent).toContain('open ledger')
    expect(document.body.textContent).toContain('box-2')
    expect(document.body.textContent).toContain('closed ledger')
  })
})
