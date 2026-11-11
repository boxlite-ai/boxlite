/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

'use client'

import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as React from 'react'

import { cn } from '@/lib/utils'

type TabsVariant = 'default' | 'underline' | 'segmented'

/*
 * Classes every variant's trigger shares: layout, focus ring and disabled
 * handling. Each variant appends its own shape and selected state.
 *
 * A variant string replaces this one rather than merging into it, so a variant
 * written as a fresh copy silently loses whatever the author forgot — the
 * `segmented` string below lost the focus ring, then `font-medium`, before it
 * ever ran. Deriving from one const is what makes that unrepresentable. `cn` is
 * clsx + twMerge, so a variant needing a different value for one of these
 * (underline's taller padding) just restates that class and wins.
 */
const TRIGGER_BASE =
  'inline-flex items-center justify-center whitespace-nowrap py-1 font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

/*
 * `segmented` — square segments sharing collapsed edges.
 *
 * The chosen segment is the one lifted *out* of the strip: the strip's resting
 * surface is `--card`, and the active segment alone is `--background`, the
 * surface of the panel it opens. Weight and value do the rest — the active
 * label is the only one at `foreground` and `font-semibold`.
 *
 * Not `--accent`, which this repo has used for a selected fill (`Sidebar`,
 * `ui/toggle`, `ui/calendar`): it sits ~4 lightness points off the surface it
 * renders on — measured 1.18:1 light, 1.21:1 dark — which is why "which one is
 * selected?" was hard to answer on these strips, and it is also the hover tint,
 * so the two states conflated. Not `--brand` either: brand marks what is live
 * (a running box, a rising cost), and spending it on a click leaves nothing to
 * say "this one is actually doing something".
 */
const SEGMENTED_LIST = 'inline-flex h-9 w-fit items-center justify-start gap-0 rounded-none bg-card p-0'

const SEGMENTED_TRIGGER = [
  TRIGGER_BASE,
  // Every segment carries all four edges and pulls left by a pixel so the
  // shared ones collapse into single rules. That is what lets the active
  // segment brighten its *whole* outline; with a `border-r` divider it could
  // only ever recolour one side, which does not read as an enclosure.
  '-ml-px h-full gap-1.5 rounded-none border border-border px-5 text-meta first:ml-0',
  'text-muted-foreground hover:text-foreground',
  // `relative z-10` so the brightened outline wins the collapse against its
  // neighbours instead of being half-covered by them.
  'data-[state=active]:relative data-[state=active]:z-10 data-[state=active]:border-border-selected',
  'data-[state=active]:bg-background data-[state=active]:font-semibold data-[state=active]:text-foreground',
].join(' ')

const TabsVariantContext = React.createContext<TabsVariant>('default')

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext.Provider value={variant}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn(
          variant === 'underline'
            ? 'inline-flex items-center w-full bg-transparent border-b border-border rounded-none h-auto p-0 gap-0 justify-start shrink-0 text-muted-foreground'
            : variant === 'segmented'
              ? SEGMENTED_LIST
              : 'inline-flex h-9 items-center justify-center bg-muted p-1 text-muted-foreground',
          className,
        )}
        {...props}
      />
    </TabsVariantContext.Provider>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const variant = React.useContext(TabsVariantContext)
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        variant === 'underline'
          ? `${TRIGGER_BASE} rounded-none border-b-2 border-transparent px-4 py-2.5 text-body data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none`
          : variant === 'segmented'
            ? SEGMENTED_TRIGGER
            : `${TRIGGER_BASE} px-3 text-body data-[state=active]:bg-card data-[state=active]:text-foreground`,
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 outline-none', className)} {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger, TRIGGER_BASE }
