// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ModelsAggregatedUsage, ModelsBoxUsage } from '@boxlite-ai/analytics-api-client'
import { UsageSummary } from './AggregatedUsageChart'
import { BoxUsageTable } from './BoxUsageTable'

type RatingAwareProps<T> = {
  data: T
  isLoading: boolean
  isRated: boolean
}

const UnratedUsageSummary = UsageSummary as React.ComponentType<RatingAwareProps<ModelsAggregatedUsage>>
const UnratedBoxUsageTable = BoxUsageTable as React.ComponentType<RatingAwareProps<ModelsBoxUsage[]>>

describe('built-in usage pricing state', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  it('labels built-in analytics as unrated and does not render zero-dollar prices', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    await act(async () => {
      root?.render(
        <>
          <UnratedUsageSummary
            data={{
              boxCount: 1,
              totalCPUSeconds: 120,
              totalDiskGBSeconds: 600,
              totalGPUSeconds: 0,
              totalPrice: 0,
              totalRAMGBSeconds: 240,
            }}
            isLoading={false}
            isRated={false}
          />
          <UnratedBoxUsageTable
            data={[
              {
                boxId: 'box-1',
                totalCPUSeconds: 120,
                totalDiskGBSeconds: 600,
                totalGPUSeconds: 0,
                totalPrice: 0,
                totalRAMGBSeconds: 240,
              },
            ]}
            isLoading={false}
            isRated={false}
          />
        </>,
      )
    })

    expect(document.body.textContent).toContain('Not rated')
    expect(document.body.textContent).not.toContain('Total Cost')
    expect(document.body.textContent).not.toContain('Total Price')
    expect(document.body.textContent).not.toContain('$0.00')
  })
})
