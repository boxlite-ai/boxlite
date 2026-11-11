/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Container, TerminalSquare } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { cn } from '@/lib/utils'
import { generatePath, Link } from 'react-router-dom'

export function BoxPageNavigation({
  boxId,
  current,
  className,
}: {
  boxId: string
  current: 'overview' | 'terminal'
  className?: string
}) {
  return (
    <nav
      aria-label="Box pages"
      className={cn('flex shrink-0 gap-4 border-b border-border font-mono text-meta', className)}
    >
      {(
        [
          { page: 'overview', label: 'Overview', path: RoutePath.BOX_DETAILS, icon: Container },
          { page: 'terminal', label: 'Terminal', path: RoutePath.BOX_TERMINAL, icon: TerminalSquare },
        ] as const
      ).map(({ page, label, path, icon: Icon }) => (
        <Link
          key={page}
          to={generatePath(path, { boxId })}
          aria-current={current === page ? 'page' : undefined}
          className={cn(
            'inline-flex h-10 items-center gap-2 border-b-2 px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground',
            current === page
              ? 'border-brand text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  )
}
