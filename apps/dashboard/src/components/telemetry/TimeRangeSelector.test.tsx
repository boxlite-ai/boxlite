// @vitest-environment jsdom
/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TimeRangeSelector } from './TimeRangeSelector'

const picker = vi.hoisted(() => ({
  onChange: undefined as ((range: { from?: Date; to?: Date }) => void) | undefined,
  allTimeEnabled: undefined as boolean | undefined,
}))

vi.mock('@/components/ui/date-range-picker', () => ({
  DateRangePicker: ({
    onChange,
    allTimeEnabled,
  }: {
    onChange: (range: { from?: Date; to?: Date }) => void
    allTimeEnabled?: boolean
  }) => {
    picker.onChange = onChange
    picker.allTimeEnabled = allTimeEnabled
    return <div>Date range</div>
  },
}))

describe('TimeRangeSelector', () => {
  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    document.body.innerHTML = ''
    picker.onChange = undefined
    picker.allTimeEnabled = undefined
  })

  it('rejects custom ranges beyond the backend limit', () => {
    const onChange = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<TimeRangeSelector onChange={onChange} maxRangeMs={24 * 60 * 60 * 1000} />))
    onChange.mockClear()

    act(() =>
      picker.onChange?.({
        from: new Date('2026-08-10T00:00:00.000Z'),
        to: new Date('2026-08-13T00:00:00.000Z'),
      }),
    )

    expect(onChange).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Select a range of 24 hours or less.')
    expect(picker.allTimeEnabled).toBe(false)

    act(() =>
      picker.onChange?.({
        from: new Date('2026-08-12T23:00:00.000Z'),
        to: new Date('2026-08-13T00:00:00.000Z'),
      }),
    )
    expect(onChange).toHaveBeenCalledWith(
      new Date('2026-08-12T23:00:00.000Z'),
      new Date('2026-08-13T00:00:00.000Z'),
    )

    act(() => root.unmount())
  })
})
