/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { subscribeBusinessEvents } from '../../common/utils/business-event.util'
import { Job } from '../entities/job.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { recordBoxJobOutcome } from './box-business-event.util'

describe('finished Box job observations', () => {
  const box = { id: 'box-1', organizationId: 'org-1' }
  let observed: Readonly<Record<string, string>>[]
  let dispose: () => void

  function finishedJob(id = 'job-1'): Job {
    const job = new Job({
      id,
      type: JobType.START_BOX,
      status: JobStatus.COMPLETED,
      runnerId: 'runner-1',
      resourceType: ResourceType.BOX,
      resourceId: box.id,
      payload: '{"secret":"private-payload"}',
      errorMessage: 'private-runner-error',
      startedAt: new Date('2026-09-29T08:00:01Z'),
      completedAt: new Date('2026-09-29T08:00:03Z'),
    })
    job.createdAt = new Date('2026-09-29T08:00:00Z')
    return job
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    observed = []
    dispose = subscribeBusinessEvents((attributes) => observed.push(attributes))
  })
  afterEach(() => {
    dispose()
    jest.restoreAllMocks()
  })

  it.each([true, false, null, undefined])(
    'counts started custom images only with persisted tenant provenance %s',
    (owned) => {
      const job = finishedJob()
      recordBoxJobOutcome('box.start', JobStatus.COMPLETED, { ...box, imageIsOrgOwned: owned }, job)
      recordBoxJobOutcome('box.start', JobStatus.COMPLETED, { ...box, imageIsOrgOwned: owned }, job)
      const features = observed.filter((event) => event['event.name'] === 'cloud.feature.use')
      if (owned === true) {
        expect(features).toHaveLength(2)
        expect(features[0]).toMatchObject({
          'feature.name': 'custom_image',
          'feature.evidence': 'started_image',
          'event.timestamp': job.completedAt!.toISOString(),
        })
        expect(features[0]['event.id']).toBe(features[1]['event.id'])
        expect(features[0]['event.id']).not.toBe(observed[0]['event.id'])
      } else expect(features).toHaveLength(0)
    },
  )

  it('excludes failed starts and stops from custom image evidence', () => {
    const custom = { ...box, imageIsOrgOwned: true }
    recordBoxJobOutcome('box.start', JobStatus.FAILED, custom, finishedJob())
    recordBoxJobOutcome('box.stop', JobStatus.COMPLETED, custom, finishedJob())
    const imported = finishedJob()
    imported.type = JobType.IMPORT_CHECKPOINT
    recordBoxJobOutcome('box.create', JobStatus.COMPLETED, custom, imported)
    expect(observed.every((event) => event['event.name'] !== 'cloud.feature.use')).toBe(true)
  })

  it('preserves occurrence identity, source time and duration when a finished job is observed again', () => {
    const job = finishedJob()
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)

    expect(observed[0]).toMatchObject({
      'job.id': job.id,
      'job.created_at': job.createdAt.toISOString(),
      'job.started_at': job.startedAt!.toISOString(),
      'job.completed_at': job.completedAt!.toISOString(),
      'job.duration_ms': '3000',
      'event.timestamp': job.completedAt!.toISOString(),
      'event.id': expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(observed[1]).toEqual(observed[0])
    expect(JSON.stringify(observed)).not.toMatch(/private-payload|private-runner-error|runner-1/)
  })

  it('distinguishes jobs on one Box and logical outcomes for one job', () => {
    const first = finishedJob()
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, first)
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, finishedJob('job-2'))
    recordBoxJobOutcome('box.start', JobStatus.FAILED, box, first)
    expect(new Set(observed.map((event) => event['event.id'])).size).toBe(3)
    expect(observed[2]).toMatchObject({ 'event.outcome': 'exception', 'exception.type': 'runner_job_failed' })
  })

  it.each([null, new Date(NaN)])('omits unsupported completion timing for %s', (completedAt) => {
    const job = finishedJob()
    job.completedAt = completedAt
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    expect(observed[0]).not.toHaveProperty('job.completed_at')
    expect(observed[0]).not.toHaveProperty('job.duration_ms')
    expect(observed[0]['event.id']).not.toBe(observed[1]['event.id'])
  })

  it.each([new Date(NaN), new Date('2026-09-29T08:00:04Z')])(
    'omits invalid or reversed durations without discarding valid completion identity',
    (createdAt) => {
      const job = finishedJob()
      job.createdAt = createdAt
      recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
      recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
      expect(observed[0]).not.toHaveProperty('job.duration_ms')
      expect(observed[1]['event.id']).toBe(observed[0]['event.id'])
    },
  )

  it('retains zero duration and replay identity when startedAt is missing', () => {
    const job = finishedJob()
    job.startedAt = null
    job.createdAt = job.completedAt!
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box, job)
    expect(observed[0]['job.duration_ms']).toBe('0')
    expect(observed[0]).not.toHaveProperty('job.started_at')
    expect(observed[1]['event.id']).toBe(observed[0]['event.id'])
  })

  it('keeps callers without a Job compatible', () => {
    recordBoxJobOutcome('box.start', JobStatus.COMPLETED, box)
    expect(observed[0]).toMatchObject({ 'event.outcome': 'success', 'correlation.id': box.id })
    expect(observed[0]).not.toHaveProperty('job.id')
    expect(observed[0]).not.toHaveProperty('job.duration_ms')
  })
})
