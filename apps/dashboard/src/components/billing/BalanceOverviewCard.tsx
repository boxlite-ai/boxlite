/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { ArrowUpRight } from '@/components/ui/icon'
import { BRAND, CardBrand } from './ascii'
import { toast } from 'sonner'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

interface BalanceOverviewCardProps {
  currentBalanceCents: number
  spentThisMonthCents: number
  creditCardConnected: boolean
  cardLast4?: string
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        <span style={{ color: BRAND }}>▸</span> {label}
      </span>
      <div className="flex items-baseline gap-[3px] text-foreground">
        <span className="font-mono text-[20px] font-semibold leading-none tracking-tight">$</span>
        <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums">{value}</span>
      </div>
    </div>
  )
}

export function BalanceOverviewCard({
  currentBalanceCents,
  spentThisMonthCents,
  creditCardConnected,
  cardLast4 = '4242',
}: BalanceOverviewCardProps) {
  const [connected, setConnected] = useState(creditCardConnected)
  const fmt = (cents: number) => (cents / 100).toFixed(2)

  const connectCard = () => {
    setConnected(true)
    toast.success('Card connected', { description: `VISA ···· ${cardLast4} added via Stripe.` })
  }

  return (
    <div className="flex flex-col border border-border bg-card">
      {/* 上：余额指标 */}
      <div className="flex flex-col gap-8 px-[22px] py-6 sm:flex-row sm:gap-16">
        <Metric label="Current balance" value={fmt(currentBalanceCents)} />
        <Metric label="Spent this month" value={fmt(spentThisMonthCents)} />
      </div>

      {/* 下：Payment method —— 横向一行 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border px-[22px] py-[14px]">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
          <span style={{ color: BRAND }}>▸</span> Payment method
        </span>
        {connected ? (
          <>
            <span className="flex items-center gap-4 font-mono text-[18px] tracking-[2px] text-foreground">
              <CardBrand brand="visa" size="lg" />
              ···· {cardLast4}
            </span>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="secondary" className="ml-auto">
                  Add funds
                  <ArrowUpRight className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Add funds</AlertDialogTitle>
                  <AlertDialogDescription>
                    You will be charged <span className="font-mono text-foreground">$100.00</span> to VISA ···· {cardLast4}{' '}
                    via Stripe.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => toast.success('Funds added', { description: '$100.00 added to your balance.' })}
                  >
                    Confirm
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <span className="flex items-center gap-2 font-mono text-[12px] text-muted-foreground">
              <span className="inline-block size-[9px] border border-muted-foreground/50" />
              no card connected
            </span>
            <Button size="sm" className="ml-auto" onClick={connectCard}>
              Connect card
              <ArrowUpRight className="size-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
