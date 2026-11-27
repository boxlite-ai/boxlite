/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { OrganizationPlan, Plan } from '@/billing-api'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { getLocalStorageItem, setLocalStorageItem } from './local-storage'

const EXPLORING_USE_CASE = {
  id: 'exploring',
  label: 'Just exploring',
  name: 'first-box',
  description: 'An isolated environment for running your code.',
  tool: 'Claude Code',
} as const

export const FIRST_RUN_USE_CASES = [
  {
    id: 'coding-agent',
    label: 'Coding agent',
    name: 'agent-workspace',
    description: 'A Python Box for your coding agent.',
    tool: 'Codex',
  },
  {
    id: 'code-execution',
    label: 'Run tests or CI',
    name: 'python-box',
    description: 'An isolated environment for running tests and CI jobs.',
    tool: 'Python SDK',
  },
  {
    id: 'browser-agent',
    label: 'Browser automation',
    name: 'browser-workspace',
    description: 'Start with a Python Box, then add your browser tools.',
    tool: 'Python SDK',
  },
  {
    id: 'long-running-agent',
    label: 'Long-running agents',
    name: 'agent-workspace',
    description: 'A Box for continuously running agents.',
    tool: 'Python SDK',
  },
  {
    id: 'application-deployments',
    label: 'Application deployments',
    name: 'app-workspace',
    description: 'Start with an isolated Box for your application.',
    tool: 'TypeScript SDK',
  },
  {
    id: 'reinforcement-learning',
    label: 'Reinforcement learning',
    name: 'rl-workspace',
    description: 'A Python Box for your reinforcement learning experiments.',
    tool: 'Python SDK',
  },
  EXPLORING_USE_CASE,
] as const
export type FirstRunUseCase = (typeof FIRST_RUN_USE_CASES)[number]['id']
export interface FirstRunWelcome {
  organizationName: string
  useCase: FirstRunUseCase | null
  note: string
  completedAt?: number | null
}

export type WelcomeSubscriptionScope = { userId: string; organizationId: string }

export function isPaidSelfServePlan(plan: Plan): plan is Plan & { priceMonthlyCents: number } {
  return (
    plan.selfServe &&
    plan.priceMonthlyCents !== null &&
    Number.isSafeInteger(plan.priceMonthlyCents) &&
    plan.priceMonthlyCents > 0
  )
}

export function isActivePlan(plan: OrganizationPlan | null, planId: string) {
  return plan?.planId === planId && plan.status === 'active'
}

export function recordWelcomeCompletion(userId: string, organizationId: string, welcome?: FirstRunWelcome): number {
  const key = `boxlite:welcome:${userId}:${organizationId}`
  const completedAt = Date.now()
  let saved = welcome
  if (!saved) {
    try {
      saved = JSON.parse(getLocalStorageItem(key) ?? 'null')
    } catch {
      /* Invalid progress must not block completion after checkout. */
    }
  }
  setLocalStorageItem(key, JSON.stringify({ ...saved, completedAt }))
  setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${userId}`, 'true')
  return completedAt
}
