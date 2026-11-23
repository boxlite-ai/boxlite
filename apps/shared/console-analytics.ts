/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { RoutePath } from './console-routes'

export const consolePages = Object.values(RoutePath).filter((page) => page.startsWith('/dashboard/'))
export const consoleActions = [
  'confirm_plan_change',
  'connect_github',
  'connect_github_account',
  'connect_registry',
  'create_api_key',
  'create_box',
  'create_checkpoint',
  'create_custom_domain',
  'create_volume',
  'new_api_key',
  'new_box',
  'new_checkpoint',
  'new_custom_domain',
  'new_image_tag',
  'new_managed_domain',
  'new_registry',
  'new_volume',
  'pin_image_tag',
  'redeem_coupon',
  'request_managed_domain',
  'save_auto_top_up',
  'save_ci_limit',
  'select_plan',
  'top_up_wallet',
  'update_ci_connection',
  'update_registry',
  'verify_custom_domain',
  'view_billing_overview',
  'view_billing_plans',
  'view_billing_usage',
  'view_billing_wallet',
  'view_custom_domains',
  'view_managed_domains',
]
export const billingTabs = ['overview', 'plans', 'usage', 'wallet']
export const consoleControls = ['a', 'button', 'menuitem', 'tab']
export const analyticsNoticeVersion = 1

export type AnalyticsPreference = { allowed: boolean | null; version: number; decidedAt: string | null }

export type ConsoleInteraction = {
  event: '$pageview' | 'console_control_click'
  page: RoutePath
  occurredAt: string
  control?: string
  destination?: RoutePath
  action?: string
  billingTab?: string
}
