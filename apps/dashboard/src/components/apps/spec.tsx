/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Check, ChevronRight, Copy, MoreHorizontal, Search } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'

// Small presentation pieces shared by the Apps pages. They speak the console's
// own design language (components/ascii.tsx, the Boxes and Volumes tables, box
// details): ▸ TRACKED section labels, bordered panels and controls, square
// status marks, uppercase table headers, dotted leaders on spec rows. Apps is a
// part of the console, so it must not look like a different product.

export { Panel } from '@/components/ascii'

/** Section heading, as on box details: ▸ TITLE, a count, a dashed rule, an optional action. */
export function SectionTitle({ title, count, right }: { title: string; count?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-[30px] items-center gap-[9px]">
      <span className="text-label leading-none text-brand">▸</span>
      <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[2px] text-foreground">{title}</span>
      {count !== undefined && <span className="font-mono text-[11px] text-muted-foreground">{count}</span>}
      <span className="flex-1 border-t border-dashed border-border" />
      {right && <span className="flex items-center gap-[6px]">{right}</span>}
    </div>
  )
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
    <span className={cn('inline-flex items-center gap-1.5 font-mono', caps ? 'text-[11px]' : 'text-meta', className)}>
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
        className="inline-flex items-center gap-1 font-mono text-meta text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35"
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

/** Label / value with a dotted leader, as on box details. Keep it in a narrow column. */
export function SpecRow({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="mb-[6px] flex items-baseline gap-2 font-mono text-body" title={title}>
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="-translate-y-1 flex-1 border-b border-dotted border-border" />
      <span className="min-w-0 max-w-[66%] truncate text-right text-foreground">{children}</span>
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
        <div className="px-4 pt-3 font-mono text-label uppercase text-muted-foreground">
          <span className="text-brand">▸</span> {label}
        </div>
      )}
      <div className="flex items-start gap-3 px-4 py-3">
        <pre
          className={cn(
            'min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-foreground',
            compact ? 'text-[12px] leading-[1.65]' : 'text-[13px] leading-[1.7]',
          )}
        >
          {text}
        </pre>
        <button
          type="button"
          onClick={() => {
            copyText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="inline-flex shrink-0 items-center gap-1.5 border border-border px-[9px] py-[5px] font-mono text-[11px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
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
    <div
      className={cn(
        `grid ${grid} items-center border-b border-border px-2 py-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground`,
        className,
      )}
    >
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
        `group grid ${grid} min-h-[52px] items-center border-b border-border/60 px-2 py-[10px] font-mono text-body transition-colors`,
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
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center font-mono">
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
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'dangerSolid'
  disabled?: boolean
  className?: string
  title?: string
  /** Shows a spinner and blocks repeat clicks while the action runs. */
  loading?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        // The console's two button forms (ascii AsciiButton, the Volumes dialog): a filled primary and a bordered
        // secondary. Danger is the bordered form in red; the solid form is reserved for the final destructive step.
        'inline-flex h-9 items-center justify-center gap-2 px-4 font-mono text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-primary font-semibold text-primary-foreground transition-opacity hover:opacity-85',
        variant === 'secondary' && 'border border-border text-foreground hover:border-brand',
        variant === 'danger' && 'border border-border text-destructive hover:border-destructive',
        variant === 'dangerSolid' && 'bg-destructive font-semibold text-white hover:opacity-90',
        className,
      )}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
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
    <label
      className={cn(
        'flex h-9 w-[380px] max-w-full items-center gap-[11px] border border-dashed border-border bg-card px-[14px] transition-colors focus-within:border-brand',
        className,
      )}
    >
      <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border-0 bg-transparent p-0 font-mono text-body text-foreground outline-none placeholder:text-muted-foreground"
      />
      {count !== undefined && (
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
          {count}
        </span>
      )}
    </label>
  )
}

/** The console's text input (Volumes "New volume"): bordered card surface, brand focus. */
export const TEXT_INPUT =
  'h-9 border border-border bg-card px-[13px] font-mono text-body text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-brand'

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
