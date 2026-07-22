/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

/**
 * 余额耗尽 → 账号冻结（suspended）的交互提示条。
 * 触发：钱包余额 ≤ 0、运行中 Box 宽限超时被 auto-pause。
 * 引导：充值即时恢复；说明数据保留期。
 */
export function SuspendedBanner() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-destructive/60 bg-destructive/10 px-[22px] py-4">
      <div className="flex items-start gap-3">
        <span className="mt-[3px] inline-block size-[9px] shrink-0" style={{ background: 'hsl(var(--destructive))' }} />
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[13px] font-semibold text-destructive">
            Balance depleted — all boxes paused
          </span>
          <span className="font-mono text-[12px] text-muted-foreground">
            Top up to resume. Paused boxes keep their data for 14 days, then are deleted.
          </span>
        </div>
      </div>
      <Button size="sm" onClick={() => toast.info('Top up', { description: 'Redirecting to Stripe to add funds…' })}>
        Top up to resume
        <span className="ml-1">→</span>
      </Button>
    </div>
  )
}
