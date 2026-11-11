import { type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Container, Search } from '@/components/ui/icon'

/** Centers a decorative resource icon, optional guidance, and secondary actions. */
export function ResourceEmptyState({
  title,
  description,
  icon,
  children,
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="resource-empty">
      <div className="resource-empty-icon" aria-hidden="true">
        {icon ?? <Container className="size-6" />}
      </div>
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      {description && <div className="max-w-md text-body leading-relaxed text-muted-foreground">{description}</div>}
      {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-3">{children}</div>}
    </div>
  )
}

/** Normalizes known status labels; callers can preserve unfamiliar upstream values verbatim. */
export function StatusIndicator({
  label,
  color,
  className,
  normalizeLabel = true,
  ...props
}: ComponentProps<'span'> & { label: ReactNode; color: string; normalizeLabel?: boolean }) {
  const text =
    normalizeLabel && typeof label === 'string'
      ? label
          .toLowerCase()
          .replaceAll('_', ' ')
          .replace(/^\w/, (letter) => letter.toUpperCase())
      : label
  return (
    <span className={cn('resource-status', className)} {...props}>
      <span aria-hidden="true" className="size-1.5 shrink-0" style={{ backgroundColor: color }} />
      <span>{text}</span>
    </span>
  )
}

/** Shared filter presentation; each resource retains its own filtering and pagination behavior. */
export function ResourceFilter({
  label,
  value,
  onChange,
  count,
  disabled,
  maxLength,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  count: ReactNode
  disabled?: boolean
  maxLength?: number
}) {
  return (
    <div className="resource-filter">
      <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <input
        aria-label={label}
        placeholder={`${label}…`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}
