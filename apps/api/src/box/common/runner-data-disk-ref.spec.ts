/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { isDiskCapacityExpandable, isGcpDataDiskRef, RunnerDataDiskRef } from './runner-data-disk-ref'

const completeRef: RunnerDataDiskRef = {
  provider: 'gcp',
  project: 'boxlite-prod-project',
  zone: 'us-central1-a',
  diskName: 'boxlite-runner-data-host-1',
}

describe('isDiskCapacityExpandable', () => {
  it('treats a ref without a diskType as the hyperdisk default (pre-field binaries)', () => {
    expect(isDiskCapacityExpandable(completeRef)).toBe(true)
    expect(isDiskCapacityExpandable({ ...completeRef, diskType: '' })).toBe(true)
  })

  it('keeps explicit hyperdisk_balanced expandable', () => {
    expect(isDiskCapacityExpandable({ ...completeRef, diskType: 'hyperdisk_balanced' })).toBe(true)
  })

  it('excludes backends without a block-disk resize path', () => {
    expect(isDiskCapacityExpandable({ ...completeRef, diskType: 'filestore' })).toBe(false)
    expect(isDiskCapacityExpandable({ ...completeRef, diskType: 'unknown_future_type' })).toBe(false)
  })

  it('keeps the structural gate ahead of the type gate', () => {
    // A complete non-GCP identity parses fine but stays outside the provider.
    expect(isDiskCapacityExpandable({ ...completeRef, provider: 'aws', diskType: 'hyperdisk_balanced' })).toBe(false)
    // A missing identity field is not expandable regardless of type.
    expect(isDiskCapacityExpandable({ ...completeRef, diskName: '' })).toBe(false)
  })
})

describe('isGcpDataDiskRef', () => {
  it('requires the full identity', () => {
    expect(isGcpDataDiskRef(null)).toBe(false)
    expect(isGcpDataDiskRef(undefined)).toBe(false)
    expect(isGcpDataDiskRef({ provider: 'gcp', project: '', zone: 'z', diskName: 'd' })).toBe(false)
    expect(isGcpDataDiskRef(completeRef)).toBe(true)
  })
})
