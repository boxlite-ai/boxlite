import { TabValue } from '@/components/boxes/SearchParams'

const EXPERIMENT_TABS: TabValue[] = ['logs', 'traces', 'metrics', 'spending']

interface BoxContentTabsOptions {
  experimentsEnabled?: boolean
}

export function getBoxContentTabs({ experimentsEnabled }: BoxContentTabsOptions): TabValue[] {
  return ['overview', ...(experimentsEnabled ? EXPERIMENT_TABS : [])]
}

export function isBoxContentTabAvailable(tab: TabValue, options: BoxContentTabsOptions): boolean {
  return getBoxContentTabs(options).includes(tab)
}
