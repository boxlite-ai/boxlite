/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { cn } from '@/lib/utils'
import { NavLink } from 'react-router-dom'

const billingRoutes = [
  { label: 'Spending', path: RoutePath.BILLING_SPENDING },
  { label: 'Wallet & invoices', path: RoutePath.BILLING_WALLET },
] as const

export function BillingNavigation() {
  return (
    <nav aria-label="Billing" className="ml-auto flex border border-border bg-card">
      {billingRoutes.map((route) => (
        <NavLink
          key={route.path}
          to={route.path}
          className={({ isActive }) =>
            cn(
              'border-r border-border px-3 py-2 text-xs text-muted-foreground transition-colors last:border-r-0 hover:text-foreground',
              isActive && 'bg-accent font-medium text-foreground',
            )
          }
        >
          {route.label}
        </NavLink>
      ))}
    </nav>
  )
}
