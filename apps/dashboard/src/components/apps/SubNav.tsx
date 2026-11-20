/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { ResourceSectionHeading } from '@/components/ResourceLayout'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useAppsScope } from '@/lib/apps/client'
import type { ReactNode } from 'react'

// Secondary screens use the shared segmented control and keyboard tab navigation.

export interface SubNavItem<T extends string> {
  id: T
  label: string
  count?: ReactNode
  disabled?: boolean
  danger?: boolean
}

export function Workbench<T extends string>({
  items,
  value,
  onChange,
  children,
}: {
  /** Kept for callers; the feature is already named by the tab above. */
  feature?: string
  items: SubNavItem<T>[]
  value: T
  onChange: (next: T) => void
  children: ReactNode
}) {
  if (items.length === 0) return <>{children}</>
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} className="min-w-0 gap-6">
      <TabsList
        variant="segmented"
        className="max-w-full shrink-0 self-start overflow-x-auto overflow-y-hidden"
        aria-label="Section"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.id}
            value={item.id}
            disabled={item.disabled}
            className={cn('gap-2 font-sans', item.danger && 'text-destructive')}
          >
            {item.label}
            {item.count !== undefined && <span className="tabular-nums text-muted-foreground">{item.count}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.id} value={item.id} className="min-w-0">
          {item.id === value && children}
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** A screen inside the workbench: a shared section heading with its actions, then the body. */
export function Screen({
  title,
  actions,
  children,
  padded = true,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  padded?: boolean
}) {
  return (
    <section className="flex min-h-[360px] flex-col">
      <ResourceSectionHeading title={title} right={actions} />
      {padded ? (
        <div className="min-w-0 flex-1 pt-1 font-sans text-body">{children}</div>
      ) : (
        // Tables keep their columns on a narrow pane and scroll sideways instead of overlapping.
        <div className="min-w-0 flex-1 overflow-x-auto font-sans text-body">
          <div className="min-w-[720px]">{children}</div>
        </div>
      )}
    </section>
  )
}

/** Toolbar and row button, in the console's bordered form; the one primary action of an area is filled. */
export function ToolButton({
  children,
  onClick,
  disabled,
  primary,
  danger,
  title,
  label,
  loading,
  requiresWrite = false,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
  title?: string
  /** The accessible name, when the visible text alone is ambiguous (one of several "Restore"). */
  label?: string
  /** Shows a spinner and blocks repeat clicks while the action runs. */
  loading?: boolean
  requiresWrite?: boolean
}) {
  const { canWrite } = useAppsScope()
  return (
    <Button
      type="button"
      title={title}
      aria-label={label}
      size="sm"
      variant={primary ? 'default' : danger ? 'danger' : 'outline'}
      disabled={disabled || loading || (requiresWrite && !canWrite)}
      onClick={onClick}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </Button>
  )
}

/**
 * Filter option, as one segment of the console's segmented control. Put a group
 * in <FilterGroup> so neighbouring segments share their edges.
 */
export function FilterChip({
  selected,
  disabled,
  onClick,
  children,
  title,
}: {
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        '-ml-px inline-flex h-[30px] items-center gap-1 border border-border px-3 font-sans text-body outline-none transition-colors first:ml-0 focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-35',
        selected
          ? 'relative z-10 border-foreground/45 bg-background font-semibold text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

export function FilterGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex bg-card', className)}>{children}</span>
}

/** Compatibility alias while screens migrate to Workbench. */
export const SubNavLayout = Workbench
