/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export const METRIC_DISPLAY_NAMES: Record<string, string> = {
  'boxlite.box.cpu.utilization': 'CPU Utilization',
  'boxlite.box.cpu.limit': 'CPU Limit',
  'boxlite.box.memory.utilization': 'Memory Utilization',
  'boxlite.box.memory.usage': 'Memory Usage',
  'boxlite.box.memory.limit': 'Memory Limit',
  'boxlite.box.filesystem.utilization': 'Disk Utilization',
  'boxlite.box.filesystem.usage': 'Disk Usage',
  'boxlite.box.filesystem.total': 'Disk Total',
  'boxlite.box.filesystem.available': 'Disk Available',
  'system.memory.utilization': 'System Memory Utilization',
}

export function getMetricDisplayName(metricName: string): string {
  return METRIC_DISPLAY_NAMES[metricName] ?? metricName.replace(/^boxlite\.box\./, '')
}
