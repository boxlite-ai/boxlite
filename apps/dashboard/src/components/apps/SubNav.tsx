/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// Below Overview every App tab is a workbench: a feature with a few screens,
// one job each. The screens are listed in a vertical rail on the left and the
// chosen screen fills the right. The rail is the console's segmented control
// (ui/tabs "segmented") stood on end: square bordered segments sharing edges,
// the chosen one lifted onto the page surface with a brighter outline.

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
    <div className="flex min-w-0 flex-col gap-4 md:flex-row md:gap-6">
      <nav
        role="tablist"
        aria-orientation="vertical"
        // Narrow panes fall back to a scrolling row; the vertical rail needs the width.
        // Narrow panes fall back to a scrolling row; the vertical rail needs the width.
        className="flex shrink-0 overflow-x-auto bg-card md:w-[200px] md:flex-col md:self-start md:overflow-visible"
      >
        {items.map((item) => {
          const active = value === item.id
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              className={cn(
                '-ml-px flex h-9 shrink-0 items-center justify-between gap-3 whitespace-nowrap border border-border px-4 text-left font-mono text-xs outline-none transition-colors first:ml-0 focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-35 md:-mt-px md:ml-0 md:first:mt-0',
                active
                  ? 'relative z-10 border-foreground/45 bg-background font-semibold text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
                item.danger && 'text-destructive hover:text-destructive',
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.count !== undefined && (
                <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
                  {item.count}
                </span>
              )}
            </button>
          )
        })}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** A screen inside the workbench: a ▸ TITLE row with its actions, then the body. */
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
      <header className="flex min-h-[36px] shrink-0 flex-wrap items-center gap-x-[9px] gap-y-2 pb-3">
        <span className="text-label leading-none text-brand">▸</span>
        <h2 className="whitespace-nowrap font-mono text-[11px] font-normal uppercase tracking-[2px] text-foreground">
          {title}
        </h2>
        <span className="min-w-[24px] flex-1 border-t border-dashed border-border" />
        {actions && <span className="flex shrink-0 items-center gap-[6px]">{actions}</span>}
      </header>
      {padded ? (
        <div className="min-w-0 flex-1 pt-1 font-mono text-body">{children}</div>
      ) : (
        // Tables keep their columns on a narrow pane and scroll sideways instead of overlapping.
        <div className="min-w-0 flex-1 overflow-x-auto font-mono text-body">
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
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        'inline-flex h-[28px] shrink-0 items-center gap-1.5 whitespace-nowrap px-[10px] font-mono text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-40',
        primary
          ? 'bg-primary font-semibold text-primary-foreground transition-opacity hover:opacity-85'
          : danger
            ? 'border border-border text-destructive hover:border-destructive'
            : 'border border-border text-muted-foreground hover:border-brand hover:text-foreground',
      )}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
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
        '-ml-px inline-flex h-[30px] items-center gap-1 border border-border px-3 font-mono text-xs outline-none transition-colors first:ml-0 focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-35',
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
