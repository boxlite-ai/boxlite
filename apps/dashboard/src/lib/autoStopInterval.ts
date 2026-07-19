export const AUTO_STOP_INTERVAL_OPTIONS: ReadonlyArray<{
  value: number
  label: string
  isDefault?: boolean
}> = [
  { value: 0, label: 'Never stop' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes', isDefault: true },
  { value: 1800, label: '30 minutes' },
] as const

export const DEFAULT_AUTO_STOP_INTERVAL =
  AUTO_STOP_INTERVAL_OPTIONS.find((option) => option.isDefault)?.value ?? AUTO_STOP_INTERVAL_OPTIONS[0].value

export function autoStopIntervalLabel(seconds: number): string {
  const option = AUTO_STOP_INTERVAL_OPTIONS.find(({ value }) => value === seconds)
  return option?.label ?? `Custom (${seconds}s)`
}
