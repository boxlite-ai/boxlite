/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

type TextKind = 'image' | 'path' | 'hostname'

/** Slice only: display emphasis must never normalize a reference or change copied text. */
function boundaries(value: string, kind: TextKind): [number, number] {
  if (kind === 'hostname') {
    const dot = value.indexOf('.')
    return [0, dot > 0 && !value.includes(':') ? dot : value.length]
  }
  let end = value.length
  if (kind === 'path') {
    while (end > 0 && value[end - 1] === '/') end--
  } else {
    const digest = value.indexOf('@')
    const referenceEnd = digest >= 0 ? digest : value.length
    const colon = value.lastIndexOf(':', referenceEnd - 1)
    // A registry port precedes the final slash; a digest's colon is not a tag.
    end = colon > value.lastIndexOf('/', referenceEnd - 1) ? colon : referenceEnd
  }
  return end === 0 ? [0, 0] : [value.lastIndexOf('/', end - 1) + 1, end]
}

/** Technical names retain their exact text while context and version read at quieter weights. */
export function TechnicalText({
  value,
  kind = 'image',
  className,
}: {
  value: string
  kind?: TextKind
  className?: string
}) {
  const [start, end] = boundaries(value, kind)
  return (
    <span className={cn('font-mono', className)} title={value}>
      <span data-part="prefix" className="text-muted-foreground">
        {value.slice(0, start)}
      </span>
      <span data-part="name" className="text-foreground">
        {value.slice(start, end)}
      </span>
      <span data-part="suffix" className="text-muted-foreground">
        {value.slice(end)}
      </span>
    </span>
  )
}

/** Preserve the existing formatter and its unknown-value semantics; only subordinate the unit. */
export function FormattedBytes({ bytes }: { bytes: number | null | undefined }) {
  const formatted = formatBytes(bytes)
  const separator = formatted.lastIndexOf(' ')
  return separator < 0 ? (
    formatted
  ) : (
    <span className="whitespace-nowrap font-mono tabular-nums">
      <span className="text-foreground">{formatted.slice(0, separator)}</span>
      <span className="text-[0.86em] text-muted-foreground">{formatted.slice(separator)}</span>
    </span>
  )
}
