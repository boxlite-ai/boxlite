/**
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Enum for all route paths in the application
 * Use this for consistent route references across the app
 */
export enum RoutePath {
  // Main routes
  LANDING = '/',
  LOGOUT = '/logout',
  DASHBOARD = '/dashboard',
  DOCS = '/docs',
  SLACK = '/slack',

  // Dashboard sub-routes
  KEYS = '/dashboard/keys',
  BOXES = '/dashboard/boxes',
  BILLING = '/dashboard/billing',
  PRICING = '/dashboard/pricing',
  IMAGES = '/dashboard/images',
  VOLUMES = '/dashboard/volumes',
  LIMITS = '/dashboard/limits',
  BILLING_SPENDING = '/dashboard/billing/spending',
  /** Parent of BILLING_PLAN_CHANGE. Carries no id of its own, so it only redirects. */
  BILLING_PLAN = '/dashboard/billing/plan',
  /** Confirming a switch to `:planId`. Cancelling a subscription outright is not
   *  reachable here — it takes a null plan id, which this segment cannot carry. */
  BILLING_PLAN_CHANGE = '/dashboard/billing/plan/:planId',
  BILLING_WALLET = '/dashboard/billing/wallet',
  MEMBERS = '/dashboard/members',
  ROLES = '/dashboard/roles',
  SETTINGS = '/dashboard/settings',
  ONBOARDING = '/dashboard/onboarding',
  AUDIT_LOGS = '/dashboard/audit-logs',
  REGIONS = '/dashboard/regions',
  RUNNERS = '/dashboard/runners',
  EXPERIMENTAL = '/dashboard/experimental',

  // User routes
  USER_INVITATIONS = '/dashboard/user/invitations',
  ACCOUNT_SETTINGS = '/dashboard/user/account-settings',

  // Webhooks
  WEBHOOKS = '/dashboard/webhooks',
  WEBHOOK_ENDPOINT_DETAILS = '/dashboard/webhooks/:endpointId',
  // Boxes
  BOX_DETAILS = '/dashboard/boxes/:boxId',
  BOX_TERMINAL = '/dashboard/boxes/:boxId/terminal',

  // Email verification
  EMAIL_VERIFY = '/dashboard/organization/:organizationId/verify-email/:email/:token',
}

/**
 * Returns only the path segment for dashboard sub-routes
 * Useful for nested routes under the dashboard
 */
export const getRouteSubPath = (path: RoutePath): string => {
  return path.replace('/dashboard/', '')
}
