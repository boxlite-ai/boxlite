/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export const METRIC_DISPLAY_NAMES: Record<string, string> = {
  'boxlite.sandbox.cpu.utilization': 'CPU Utilization',
  'boxlite.sandbox.cpu.limit': 'CPU Limit',
  'boxlite.sandbox.memory.utilization': 'Memory Utilization',
  'boxlite.sandbox.memory.usage': 'Memory Usage',
  'boxlite.sandbox.memory.limit': 'Memory Limit',
  'boxlite.sandbox.filesystem.utilization': 'Disk Utilization',
  'boxlite.sandbox.filesystem.usage': 'Disk Usage',
  'boxlite.sandbox.filesystem.total': 'Disk Total',
  'boxlite.sandbox.filesystem.available': 'Disk Available',
  'system.memory.utilization': 'System Memory Utilization',
}

export function getMetricDisplayName(metricName: string): string {
  return METRIC_DISPLAY_NAMES[metricName] ?? metricName.replace(/^boxlite\.sandbox\./, '')
}
