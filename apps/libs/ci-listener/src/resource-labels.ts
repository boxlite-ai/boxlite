/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { validateWorkerResources, WorkerResources } from './worker'

export const DEFAULT_RESOURCE_LABEL = 'boxlite'
/** Platform and default routing labels; job resource selection replaces the routing label. */
export const DEFAULT_RUNNER_LABELS: readonly string[] = Object.freeze([
  'self-hosted',
  'linux',
  'x64',
  DEFAULT_RESOURCE_LABEL,
])

export interface ResourceSelection {
  readonly label: string
  readonly resources?: Readonly<WorkerResources>
}

/** GitHub labels route jobs; these quantities also determine the actual Box request. */
export function parseResourceLabels(labels: readonly string[]): ResourceSelection | null {
  if (labels.length > 100 || labels.some((label) => !label || label.length > 128))
    throw new Error('Invalid CI resource labels')
  const routing = labels.filter((label) => {
    const normalized = label.trim().toLowerCase()
    return normalized === DEFAULT_RESOURCE_LABEL || normalized.startsWith(DEFAULT_RESOURCE_LABEL + '-')
  })
  if (!routing.length) return null
  if (routing.length !== 1) throw new Error('Exactly one CI resource label is required')
  const label = routing[0].toLowerCase()
  if (label === DEFAULT_RESOURCE_LABEL) return Object.freeze({ label })
  // Example: boxlite-2vcpu-4gbmem-10gbdisk. GiB quantities are positive whole numbers.
  const match = /^boxlite-([1-9]\d*)vcpu-([1-9]\d*)gbmem-([1-9]\d*)gbdisk$/.exec(label)
  if (!match || match[0] !== label) throw new Error('Invalid CI resource label format')
  const resources = { cpus: Number(match[1]), memoryMiB: Number(match[2]) * 1024, diskGiB: Number(match[3]) }
  validateWorkerResources(resources)
  return Object.freeze({ label, resources: Object.freeze(resources) })
}

/** Unsupported jobs are skipped by scans without preventing unrelated jobs from progressing. */
export function selectRunnerLabels(
  requested: readonly string[],
  supported: readonly string[],
): (ResourceSelection & { readonly labels: readonly string[] }) | null {
  let selection: ResourceSelection | null
  try {
    selection = parseResourceLabels(requested)
  } catch {
    return null
  }
  if (!selection) return null
  const labels = supported.filter((label) => label.toLowerCase() !== DEFAULT_RESOURCE_LABEL)
  const available = new Set(labels.map((label) => label.toLowerCase()))
  available.add(selection.label)
  if (!requested.every((label) => available.has(label.toLowerCase()))) return null
  return Object.freeze({ ...selection, labels: Object.freeze([...labels, selection.label]) })
}
