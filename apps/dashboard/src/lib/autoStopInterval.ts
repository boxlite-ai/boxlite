export const AUTO_STOP_INTERVAL_OPTIONS: ReadonlyArray<{
  value: number
  label: string
  isDefault?: boolean
}> = [
  { value: 0, label: 'Never stop' },
  { value: 1, label: '1 minute' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes', isDefault: true },
  { value: 30, label: '30 minutes' },
] as const

export const DEFAULT_AUTO_STOP_INTERVAL =
  AUTO_STOP_INTERVAL_OPTIONS.find((option) => option.isDefault)?.value ?? AUTO_STOP_INTERVAL_OPTIONS[0].value

export function autoStopIntervalLabel(minutes: number): string {
  const option = AUTO_STOP_INTERVAL_OPTIONS.find(({ value }) => value === minutes)
  return option?.label ?? `Custom (${minutes}m)`
}
