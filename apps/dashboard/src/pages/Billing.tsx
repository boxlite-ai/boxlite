/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageDescription, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import { Logo } from '@/assets/Logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RoutePath } from '@/enums/RoutePath'
import { ArrowRight, Box, CheckCircle2, Cpu, KeyRound, ReceiptText, Terminal, Timer } from 'lucide-react'
import { Link } from 'react-router-dom'

const trialItems = [
  {
    label: 'Create Boxes',
    icon: Timer,
  },
  {
    label: 'Use terminal',
    icon: Terminal,
  },
  {
    label: 'Call the API',
    icon: KeyRound,
  },
]

const futureItems = [
  {
    label: 'Box runtime',
    icon: Box,
  },
  {
    label: 'CPU, memory, storage',
    icon: Cpu,
  },
  {
    label: 'Usage limits',
    icon: ReceiptText,
  },
]

function Billing() {
  return (
    <PageLayout>
      <PageHeader>
        <div>
          <PageTitle>Billing</PageTitle>
          <PageDescription className="mt-2 max-w-2xl">
            BoxLite is free to try right now. Billing details will be announced before paid usage starts.
          </PageDescription>
        </div>
      </PageHeader>

      <PageContent>
        <section className="grid gap-5 rounded-md border border-border bg-background p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <Badge variant="secondary">Free trial now</Badge>
            <h1 className="mt-4 max-w-2xl text-3xl font-semibold tracking-normal text-foreground">
              Billing is coming soon.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              BoxLite is currently free to try. We will publish billing details before paid usage starts, with clear
              usage and resource limits.
            </p>

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button asChild>
                <Link to={RoutePath.BOXES}>
                  Create a Box
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to={`${RoutePath.BOXES}?onboarding=1`}>Open guide</Link>
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-border bg-muted/20">
            <div className="flex h-32 items-center justify-center border-b border-border bg-background">
              <Logo className="h-20 w-20 opacity-90" decorative />
            </div>
            <div className="p-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Trial access</div>
              <div className="mt-3 text-3xl font-semibold">$0</div>
              <p className="mt-1 text-sm text-muted-foreground">No billing enabled yet.</p>
              <div className="mt-5 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-muted-foreground" />
                  Free trial access
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-muted-foreground" />
                  Shared Linux base images
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="size-4 text-muted-foreground" />
              Included during trial
            </div>
            <div className="mt-4 grid gap-2">
              {trialItems.map((item) => {
                const Icon = item.icon
                return (
                  <div key={item.label} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="size-4" />
                    {item.label}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="rounded-md border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ReceiptText className="size-4 text-muted-foreground" />
              Future billing signals
            </div>
            <div className="mt-4 grid gap-2">
              {futureItems.map((item) => {
                const Icon = item.icon
                return (
                  <div key={item.label} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="size-4" />
                    {item.label}
                  </div>
                )
              })}
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Billing will focus on the resources users actually consume.
            </p>
          </div>
        </section>
      </PageContent>
    </PageLayout>
  )
}

export default Billing
