import { TabValue } from '@/components/boxes/SearchParams'

const EXPERIMENT_TABS: TabValue[] = ['logs', 'traces', 'metrics', 'spending']

interface BoxContentTabsOptions {
  experimentsEnabled?: boolean
  vncEnabled: boolean
}

export function isDashboardVncEnabled(flagValue: boolean | undefined): boolean {
  return flagValue === true
}

export function getBoxContentTabs({ experimentsEnabled, vncEnabled }: BoxContentTabsOptions): TabValue[] {
  return [
    'overview',
    ...(experimentsEnabled ? EXPERIMENT_TABS : []),
    'terminal',
    ...(vncEnabled ? (['vnc'] as const) : []),
  ]
}

export function isBoxContentTabAvailable(tab: TabValue, options: BoxContentTabsOptions): boolean {
  return getBoxContentTabs(options).includes(tab)
}
