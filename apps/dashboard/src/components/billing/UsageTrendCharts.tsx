/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiStatCard } from './ascii'

type Point = { v: number }

function makeSeries(base: number, growth: number, wobble: number): Point[] {
  return Array.from({ length: 12 }, (_, i) => ({
    v: Math.max(0, Math.round(base + i * growth + Math.sin(i * 1.1) * wobble)),
  }))
}

interface UsageTrendChartsProps {
  costTotal?: string
  vcpuHours?: string
  ramHours?: string
  sandboxCount?: string
}

/**
 * Usage 四指标（total over selected range）— ASCII LED 点阵数字 + ▸ + 迷你 sparkline。
 * 真实实现接 analytics 时间序列；此处为演示数据。
 */
export function UsageTrendCharts({
  costTotal = '284.50',
  vcpuHours = '1,240',
  ramHours = '768',
  sandboxCount = '342',
}: UsageTrendChartsProps) {
  return (
    <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-4">
      <AsciiStatCard
        label="Usage Cost"
        prefix="$"
        value={costTotal}
        trendPct={12}
        spark={{ id: 'cost', data: makeSeries(120, 14, 18) }}
      />
      <AsciiStatCard
        label="vCPU Hours"
        value={vcpuHours}
        unit="hrs"
        trendPct={8}
        spark={{ id: 'vcpu', data: makeSeries(700, 50, 60) }}
      />
      <AsciiStatCard
        label="RAM Hours"
        value={ramHours}
        unit="GiB·hr"
        trendPct={5}
        spark={{ id: 'ram', data: makeSeries(400, 32, 40) }}
      />
      <AsciiStatCard
        label="Sandboxes"
        value={sandboxCount}
        unit="runs"
        trendPct={-3}
        spark={{ id: 'sandbox', data: makeSeries(260, 9, 28) }}
      />
    </div>
  )
}
