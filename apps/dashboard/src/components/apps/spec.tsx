/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, ChevronRight, Copy, MoreHorizontal, Search } from '@/components/ui/icon'
import { Button } from '@/components/ui/button'
import { ResourceSectionHeading } from '@/components/ResourceLayout'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useAppsScope } from '@/lib/apps/client'
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'

export { Panel } from '@/components/ascii'

/** App sections share the same heading hierarchy as other Console resources. */
export function SectionTitle({ title, count, right }: { title: string; count?: ReactNode; right?: ReactNode }) {
  return <ResourceSectionHeading title={title} count={count} right={right} />
}

/**
 * The console's status mark: a square swatch and a word. `caps` is the table
 * form (Boxes, Volumes): an uppercase, tracked label coloured by the state.
 */
export function StatusBadge({
  label,
  color,
  className,
  caps = false,
}: {
  label: ReactNode
  color: string
  className?: string
  caps?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-sans', 'text-meta', className)}>
      <span className="inline-block size-[9px] shrink-0" style={{ background: color }} />
      <span className={caps ? 'uppercase tracking-[0.5px]' : 'text-foreground'} style={caps ? { color } : undefined}>
        {label}
      </span>
    </span>
  )
}

/** Technical detail kept one click away. */
export function Disclosure({
  label = 'Details',
  children,
  defaultOpen = false,
}: {
  label?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 font-sans text-meta text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

/** A row's actions, always visible and right-aligned, as in the Boxes and Volumes tables. */
export function HoverActions({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('flex items-center justify-end gap-[6px]', className)}>{children}</span>
}

/** Aligned resource facts with technical values kept in monospace. */
export function SpecRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2 last:border-0 font-sans text-body"
      title={title}
    >
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="min-w-0 max-w-[66%] truncate font-mono text-right text-foreground">{children}</span>
    </div>
  )
}

export function copyText(text: string): boolean {
  try {
    void navigator.clipboard?.writeText(text)
    return true
  } catch {
    return false
  }
}

export function CopyIconButton({
  text,
  title = 'Copy',
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1300)
      }}
      className={cn('shrink-0 text-muted-foreground transition-colors hover:text-foreground', className)}
    >
      {copied ? <Check className="size-[13px] text-success" /> : <Copy className="size-[13px]" />}
    </button>
  )
}

/** A prompt to hand to the agent: a bordered code surface with one copy action. */
export function PromptBlock({ label, text, compact }: { label?: string; text: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="border border-border bg-[hsl(var(--code-background))]">
      {label && (
        <div className="px-4 pt-3 font-sans text-label uppercase text-muted-foreground">
          <span className="text-brand">▸</span> {label}
        </div>
      )}
      <div className="flex items-start gap-3 px-4 py-3">
        <pre
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-foreground',
            compact ? 'text-meta leading-[1.65]' : 'text-body leading-[1.7]',
          )}
        >
          {text}
        </pre>
        <Button
          type="button"
          onClick={() => {
            copyText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          variant="outline"
          size="sm"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block size-[9px] shrink-0', className)} style={{ background: color }} />
}

/** Column header for the grid tables, as in Volumes: uppercase, tracked, one rule underneath. */
export function GridHeader({ grid, columns, className }: { grid: string; columns: ReactNode[]; className?: string }) {
  return (
    <div className={cn(`resource-list-head grid ${grid} items-center`, className)}>
      {columns.map((column, i) => (
        <span key={i} className={i === columns.length - 1 ? 'text-right' : undefined}>
          {column}
        </span>
      ))}
    </div>
  )
}

export function GridRow({
  grid,
  children,
  onClick,
  className,
}: {
  grid: string
  children: ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        `resource-list-row group grid ${grid} items-center font-sans`,
        onClick && 'cursor-pointer hover:bg-card/50',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Empty state, as in the console's tables: centred, small, one bordered action. */
export function EmptyNote({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center font-sans">
      <div className="text-body font-semibold text-foreground">{title}</div>
      {children && <div className="max-w-md text-meta text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function FlatButton({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  className,
  title,
  loading,
  requiresWrite = false,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'dangerSolid'
  disabled?: boolean
  className?: string
  title?: string
  /** Shows a spinner and blocks repeat clicks while the action runs. */
  loading?: boolean
  requiresWrite?: boolean
}) {
  const { canWrite } = useAppsScope()
  return (
    <Button
      type="button"
      title={title}
      disabled={disabled || loading || (requiresWrite && !canWrite)}
      onClick={onClick}
      variant={
        variant === 'primary'
          ? 'default'
          : variant === 'dangerSolid'
            ? 'destructive'
            : variant === 'danger'
              ? 'danger'
              : 'outline'
      }
      className={className}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </Button>
  )
}

// Used as a dropdown trigger (asChild), so it must pass the trigger's ref and handlers through.
export const MoreButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(
  function MoreButton(props, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label="More"
        {...props}
        className="inline-flex size-[28px] items-center justify-center border border-border text-muted-foreground outline-none transition-colors hover:border-brand hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35 data-[state=open]:border-brand data-[state=open]:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
    )
  },
)

/** The console's filter box (Boxes, Volumes, Images): dashed frame, brand search icon, optional count. */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
  count,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  className?: string
  count?: number
}) {
  return (
    <label className={cn('resource-filter', className)}>
      <Search className="size-[15px] shrink-0" aria-hidden="true" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-0 bg-transparent p-0 font-sans text-body text-foreground outline-none placeholder:text-muted-foreground"
      />
      {count !== undefined && (
        <span className="whitespace-nowrap font-sans text-label uppercase tracking-[1px] text-muted-foreground">
          {count}
        </span>
      )}
    </label>
  )
}

/** The console's text input (Volumes "New volume"): bordered card surface, brand focus. */
export const TEXT_INPUT =
  'h-9 border border-border bg-card px-[13px] font-sans text-body text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand'

/**
 * The console's dialog frame (Volumes "New volume"): a ruled header and footer
 * around a padded body. Applied by selector so each dialog keeps its markup.
 */
export const DIALOG_FRAME = [
  'gap-4 p-0',
  '[&>[data-slot=dialog-header]]:border-b [&>[data-slot=dialog-header]]:border-border [&>[data-slot=dialog-header]]:px-6 [&>[data-slot=dialog-header]]:py-[18px]',
  '[&>[data-slot=dialog-footer]]:mt-1 [&>[data-slot=dialog-footer]]:border-t [&>[data-slot=dialog-footer]]:border-border [&>[data-slot=dialog-footer]]:px-6 [&>[data-slot=dialog-footer]]:py-4',
  '[&>*:not([data-slot])]:mx-6',
].join(' ')

/** Downloads rows as a CSV file named after what they are. */
export function downloadCsv(filename: string, columns: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const csv = [columns, ...rows].map((row) => row.map(cell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
