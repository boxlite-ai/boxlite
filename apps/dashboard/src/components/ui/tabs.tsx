/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

'use client'

import * as TabsPrimitive from '@radix-ui/react-tabs'
import { Slot } from '@radix-ui/react-slot'
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

/** Content navigation marks the current panel with a line, leaving action fills to buttons. */
const UNDERLINE_LIST =
  'inline-flex h-10 w-full shrink-0 items-end justify-start gap-6 rounded-none border-b border-border bg-transparent p-0'

const UNDERLINE_TRIGGER = [
  TRIGGER_BASE,
  // Reserve the indicator in every state and overlap the baseline without shifting content.
  'choice-trigger [--tab-icon-surface:hsl(var(--background))] relative -mb-px h-full shrink-0 gap-1.5 rounded-none border-b-2 border-transparent bg-transparent px-0 py-2 text-body focus-visible:z-20',
  'text-muted-foreground hover:text-foreground',
  'data-[state=active]:border-foreground data-[state=active]:text-foreground',
].join(' ')

/** Compact choices share a persistent neutral selected fill; borders stay equally quiet. */
const SEGMENTED_LIST = 'inline-flex h-9 w-fit items-center justify-start gap-0 rounded-none bg-transparent p-0'

const SEGMENTED_TRIGGER = [
  TRIGGER_BASE,
  // Overlap neutral edges; only keyboard focus needs to paint above neighboring segments.
  'choice-trigger [--tab-icon-surface:hsl(var(--selection))] relative -ml-px h-full shrink-0 gap-1.5 rounded-none border border-border bg-transparent px-5 text-meta first:ml-0 focus-visible:z-20',
  'text-muted-foreground hover:bg-control-hover hover:text-foreground',
  'data-[state=active]:bg-selection data-[state=active]:text-selection-foreground data-[state=active]:font-semibold data-[state=active]:hover:bg-selection data-[state=active]:hover:text-selection-foreground',
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
            ? UNDERLINE_LIST
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
          ? UNDERLINE_TRIGGER
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

/** Route destinations share content navigation styling without tab/panel keyboard semantics. */
function TabsNav({ className, ...props }: React.ComponentProps<'nav'>) {
  return <nav className={cn(UNDERLINE_LIST, className)} {...props} />
}

function TabsNavLink({
  active,
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'a'> & { active: boolean; asChild?: boolean }) {
  const Component = asChild ? Slot : 'a'
  return (
    <Component
      {...props}
      data-state={active ? 'active' : 'inactive'}
      aria-current={active ? 'page' : undefined}
      className={cn(UNDERLINE_TRIGGER, className)}
    />
  )
}

export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TabsNav,
  TabsNavLink,
  TRIGGER_BASE,
  UNDERLINE_LIST,
  UNDERLINE_TRIGGER,
  SEGMENTED_LIST,
  SEGMENTED_TRIGGER,
}
