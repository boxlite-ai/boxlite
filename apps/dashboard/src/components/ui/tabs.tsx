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
 * `segmented` — square, right-divided segments.
 *
 * Selection is drawn with `--brand`, not `--accent`. `--accent` is what this
 * repo has used for a selected fill (`Sidebar`, `ui/toggle`, `ui/calendar`),
 * but it sits ~4 lightness points off the surface it renders on — measured
 * 1.18:1 light, 1.21:1 dark — which is why "which one is selected?" is hard to
 * answer on these strips, and it is also the hover tint, so the two states
 * conflate. A brand tint at a similar 1.12:1 is no more visible on its own, so
 * the selected segment carries an inset brand rule too (2.49:1 light, 7.30:1
 * dark, alongside the weight change); that is the pairing `AsciiChip` and
 * `InterfacePicker` use, so a chosen option now looks the same across all
 * three. The label stays `foreground`: `--brand` as text measures ~2.2:1 on
 * the light theme's white surface, well under AA.
 */
const SEGMENTED_LIST =
  'inline-flex h-9 w-fit items-center justify-start gap-0 rounded-none border border-border bg-transparent p-0'

const SEGMENTED_TRIGGER = [
  TRIGGER_BASE,
  'h-full gap-1.5 rounded-none border-0 border-r border-border px-5 text-xs last:border-r-0',
  'text-muted-foreground hover:bg-accent hover:text-foreground',
  // `shadow-[inset...]` rather than a border: the segments are divided by
  // `border-r`, so recolouring one edge is not a selection marker, and giving
  // the active segment a real border would shift the strip by a pixel.
  'data-[state=active]:bg-[hsl(var(--brand)/0.12)] data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_0_0_1px_hsl(var(--brand))]',
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
              : 'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
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
          ? `${TRIGGER_BASE} rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none`
          : variant === 'segmented'
            ? SEGMENTED_TRIGGER
            : `${TRIGGER_BASE} rounded-md px-3 text-sm data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow`,
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
