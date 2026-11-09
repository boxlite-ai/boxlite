import { type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Container } from '@/components/ui/icon'

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

/** One display treatment; callers retain ownership of business-state mapping. */
export function StatusIndicator({
  label,
  color,
  className,
  ...props
}: ComponentProps<'span'> & { label: ReactNode; color: string }) {
  const text =
    typeof label === 'string'
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
