import { type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { AlertCircle, Container, Search } from '@/components/ui/icon'
import { BoxCube } from '@/components/BoxCube'
import { Button } from '@/components/ui/button'

/** Shared identity geometry; callers own links, copy controls and the displayed values. */
export function ResourceIdentity({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className="resource-object-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </span>
  )
}

/** One section hierarchy for resource details and management panels. */
export function ResourceSectionHeading({
  title,
  count,
  right,
  className,
}: {
  title: string
  count?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('mb-4 flex min-w-0 flex-wrap items-center gap-3', className)}>
      <h2 className="text-meta font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
      {count && <span className="font-mono text-meta tabular-nums text-muted-foreground">{count}</span>}
      <span aria-hidden="true" className="min-w-3 flex-1 border-t border-border/60" />
      {right}
    </div>
  )
}

/** Centers feedback within the containing resource region, including embedded lists. */
export function ResourceEmptyState({
  title,
  description,
  icon,
  children,
  role,
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  children?: ReactNode
  role?: 'status' | 'alert'
}) {
  return (
    <div className="resource-empty" role={role}>
      <div className="resource-empty-icon" aria-hidden="true">
        {icon ?? <Container />}
      </div>
      <h2 className="font-display text-section font-semibold text-foreground">{title}</h2>
      {description && <div className="max-w-md text-body leading-relaxed text-muted-foreground">{description}</div>}
      {children && <div className="mt-2 flex flex-wrap items-center justify-center gap-3">{children}</div>}
    </div>
  )
}

/** Initial requests use the same placement as empty and failed inventories. */
export function ResourceLoadingState({ title }: { title: string }) {
  return <ResourceEmptyState role="status" title={title} icon={<BoxCube state="building" size={36} />} />
}

type ResourceErrorProps = { title: string; onRetry: () => void; retrying?: boolean; retryLabel?: string }

/** A blocking failure offers recovery without exposing raw transport errors. */
export function ResourceErrorState({ title, onRetry, retrying }: ResourceErrorProps) {
  return (
    <ResourceEmptyState role="alert" title={title} icon={<AlertCircle />}>
      <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </ResourceEmptyState>
  )
}

/** Refresh and secondary-request failures leave successful content in place. */
export function ResourceErrorNotice({ title, onRetry, retrying, retryLabel = 'Retry' }: ResourceErrorProps) {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-meta text-muted-foreground"
    >
      <span>{title}</span>
      <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
        {retrying ? 'Retrying…' : retryLabel}
      </Button>
    </div>
  )
}

/** Filter misses share one recovery action and never imply that the inventory is empty. */
export function ResourceFilterEmptyState({ title, onClear }: { title: string; onClear: () => void }) {
  return (
    <ResourceEmptyState title={title} icon={<Search />} description="Try another search or clear your filter.">
      <Button type="button" variant="outline" size="sm" onClick={onClear}>
        Clear filter
      </Button>
    </ResourceEmptyState>
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
    <div className="resource-filter console-input-surface">
      <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <input
        aria-label={label}
        placeholder={`${label}…`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-body text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <span className="font-mono text-meta tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}
