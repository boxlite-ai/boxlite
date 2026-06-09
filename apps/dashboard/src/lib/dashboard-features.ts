import { TabValue } from '@/components/sandboxes/SearchParams'

const EXPERIMENT_TABS: TabValue[] = ['logs', 'traces', 'metrics', 'spending']

interface SandboxContentTabsOptions {
  experimentsEnabled?: boolean
  vncEnabled: boolean
}

export function isDashboardVncEnabled(flagValue: boolean | undefined): boolean {
  return flagValue === true
}

export function getSandboxContentTabs({ experimentsEnabled, vncEnabled }: SandboxContentTabsOptions): TabValue[] {
  return [
    'overview',
    ...(experimentsEnabled ? EXPERIMENT_TABS : []),
    'terminal',
    ...(vncEnabled ? (['vnc'] as const) : []),
  ]
}

export function isSandboxContentTabAvailable(tab: TabValue, options: SandboxContentTabsOptions): boolean {
  return getSandboxContentTabs(options).includes(tab)
}
