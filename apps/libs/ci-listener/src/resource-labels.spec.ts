/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { parseResourceLabels, selectRunnerLabels } from './resource-labels'

describe('CI resource labels', () => {
  const supported = ['self-hosted', 'linux', 'x64', 'boxlite']
  it('selects configured defaults without inventing a custom resource request', () => {
    expect(parseResourceLabels(['self-hosted', 'BOXLITE'])).toEqual({ label: 'boxlite' })
    expect(parseResourceLabels(['ubuntu-latest'])).toBeNull()
  })
  it.each([
    ['boxlite-2vcpu-4gbmem-10gbdisk', 2, 4096, 10],
    ['BOXLITE-1VCPU-1GBMEM-1GBDISK', 1, 1024, 1],
    ['boxlite-16vcpu-128gbmem-8388607gbdisk', 16, 131072, 8388607],
  ])('parses whole resource quantities in %s', (label, cpus, memoryMiB, diskGiB) => {
    expect(parseResourceLabels([label])).toEqual({
      label: label.toLowerCase(),
      resources: { cpus, memoryMiB, diskGiB },
    })
  })
  it.each([
    'boxlite-ci-runner',
    'boxlite-2vcpu-4gbmem',
    'boxlite-2cpu-4gbmem-10gbdisk',
    'boxlite-0vcpu-4gbmem-10gbdisk',
    'boxlite-17vcpu-4gbmem-10gbdisk',
    'boxlite--2vcpu-4gbmem-10gbdisk',
    'boxlite-+2vcpu-4gbmem-10gbdisk',
    'boxlite-02vcpu-4gbmem-10gbdisk',
    'boxlite-2.5vcpu-4gbmem-10gbdisk',
    'boxlite-2vcpu-0gbmem-10gbdisk',
    'boxlite-2vcpu-129gbmem-10gbdisk',
    'boxlite-2vcpu-4.5gbmem-10gbdisk',
    'boxlite-2vcpu-NaNgbmem-10gbdisk',
    'boxlite-2vcpu-Infinitygbmem-10gbdisk',
    'boxlite-2vcpu-1e2gbmem-10gbdisk',
    'boxlite-2vcpu-9007199254740992gbmem-10gbdisk',
    'boxlite-2vcpu-4gbmem-0gbdisk',
    'boxlite-2vcpu-4gbmem-8388608gbdisk',
    'boxlite-2vcpu-4gbmem-9007199254740993gbdisk',
    'boxlite-2vcpu-4gbmem-1e3gbdisk',
    'boxlite-2vcpu-4gbmem-10gbdisk\n',
    ' boxlite-2vcpu-4gbmem-10gbdisk',
    'boxlite ',
    'boxlite-' + '9'.repeat(128),
  ])('rejects malformed or out-of-range request %s', (label) => {
    expect(() => parseResourceLabels([label])).toThrow()
    expect(selectRunnerLabels([label], supported)).toBeNull()
  })
  it.each([
    ['boxlite', 'BOXLITE'],
    ['boxlite', 'boxlite-2vcpu-4gbmem-10gbdisk'],
    ['boxlite-2vcpu-4gbmem-10gbdisk', 'boxlite-2vcpu-4gbmem-10gbdisk'],
    ['boxlite-2vcpu-4gbmem-10gbdisk', 'boxlite-4vcpu-8gbmem-20gbdisk'],
  ])('rejects duplicate or conflicting routing labels %j', (...labels) => {
    expect(() => parseResourceLabels(labels)).toThrow('Exactly one')
    expect(selectRunnerLabels(labels, supported)).toBeNull()
  })
  it('advertises only the selected routing label and preserves platform matching', () => {
    const label = 'boxlite-2vcpu-4gbmem-10gbdisk'
    expect(selectRunnerLabels(['Linux', label], supported)).toEqual({
      label,
      resources: { cpus: 2, memoryMiB: 4096, diskGiB: 10 },
      labels: ['self-hosted', 'linux', 'x64', label],
    })
    expect(selectRunnerLabels(['macOS', label], supported)).toBeNull()
  })
})
