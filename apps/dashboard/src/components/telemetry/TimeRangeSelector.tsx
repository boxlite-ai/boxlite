/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { useState, useEffect } from 'react'
import { DateRangePicker, DateRangePickerRef, QuickRangesConfig } from '@/components/ui/date-range-picker'
import { DateRange } from 'react-day-picker'
import { subHours } from 'date-fns'

interface TimeRangeSelectorProps {
  onChange: (from: Date, to: Date) => void
  defaultRange?: { from: Date; to: Date }
  defaultSelectedQuickRange?: string
  quickRanges?: QuickRangesConfig
  maxRangeMs?: number
  className?: string
}

const defaultQuickRanges: QuickRangesConfig = {
  minutes: [15, 30],
  hours: [1, 3, 6, 12, 24],
  days: [3, 7],
}

export const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  onChange,
  defaultRange,
  defaultSelectedQuickRange = 'Last 1 hour',
  quickRanges = defaultQuickRanges,
  maxRangeMs,
  className,
}) => {
  const pickerRef = React.useRef<DateRangePickerRef>(null)
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    if (defaultRange) {
      return { from: defaultRange.from, to: defaultRange.to }
    }
    // Default to last 1 hour
    const now = new Date()
    return { from: subHours(now, 1), to: now }
  })
  const [rangeError, setRangeError] = useState<string>()

  useEffect(() => {
    if (dateRange.from && dateRange.to) {
      onChange(dateRange.from, dateRange.to)
    }
  }, [dateRange, onChange])

  const handleChange = (range: DateRange) => {
    if (range.from && range.to && maxRangeMs && range.to.getTime() - range.from.getTime() > maxRangeMs) {
      setRangeError(`Select a range of ${Math.floor(maxRangeMs / 3_600_000)} hours or less.`)
      return
    }
    setRangeError(undefined)
    setDateRange(range)
  }

  return (
    <div>
      <DateRangePicker
        ref={pickerRef}
        value={dateRange}
        onChange={handleChange}
        quickRangesEnabled
        quickRanges={quickRanges}
        allTimeEnabled={!maxRangeMs}
        timeSelection
        className={className}
        defaultSelectedQuickRange={defaultSelectedQuickRange}
      />
      {rangeError && <p className="mt-1 text-xs text-destructive">{rangeError}</p>}
    </div>
  )
}
