/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { TabsNav, TabsNavLink } from '@/components/ui/tabs'
import { TabIcon } from '@/components/ui/TabIcon'
import { generatePath, Link } from 'react-router-dom'

type BoxView = 'overview' | 'terminal'

export function BoxPageNavigation({
  boxId,
  current,
  className,
}: {
  boxId: string
  current: BoxView
  className?: string
}) {
  return (
    <TabsNav aria-label="Box pages" className={className}>
      {(
        [
          { page: 'overview', label: 'Overview', path: RoutePath.BOX_DETAILS },
          { page: 'terminal', label: 'Terminal', path: RoutePath.BOX_TERMINAL },
        ] as const
      ).map(({ page, label, path }) => (
        <TabsNavLink key={page} active={current === page} asChild>
          <Link to={generatePath(path, { boxId })}>
            <TabIcon name={page} />
            {label}
          </Link>
        </TabsNavLink>
      ))}
    </TabsNav>
  )
}
