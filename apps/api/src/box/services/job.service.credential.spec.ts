import { Logger } from '@nestjs/common'
import { JobService } from './job.service'
import { JobType, ResourceType, JobStatus } from '../dto/job.dto'
import { Job } from '../entities/job.entity'

describe('Credential job lifecycle', () => {
  it('preserves non-CREATE_BOX database failures', async () => {
    const failure = new Error('storage unavailable')
    const service = new JobService({ insert: jest.fn().mockRejectedValue(failure) } as any, {} as any, {} as any)
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    try {
      await expect(service.createJob(null, JobType.START_BOX, 'runner', ResourceType.BOX, 'box', {})).rejects.toBe(
        failure,
      )
    } finally {
      log.mockRestore()
    }
  })

  it.each([null, JSON.stringify({ image: 'base' })])(
    'completes a legacy job without a credential: %s',
    async (payload) => {
      const job = new Job({
        type: JobType.CREATE_BOX,
        runnerId: 'runner',
        resourceType: ResourceType.BOX,
        resourceId: 'box',
        status: JobStatus.IN_PROGRESS,
        payload,
      })
      const manager = { findOne: jest.fn().mockResolvedValue(job), save: jest.fn(async (_type, saved) => saved) }
      const service = new JobService(
        { manager: { transaction: (run: any) => run(manager) } } as any,
        {} as any,
        { handleJobCompletion: jest.fn().mockResolvedValue(undefined) } as any,
      )
      await service.updateJobStatus(job.id, JobStatus.COMPLETED)
      expect(manager.save).toHaveBeenCalledWith(Job, job)
      expect(job.payload).toBe(payload)
      expect(job.completedAt).toBeInstanceOf(Date)
    },
  )

  it('does not expose credential-bearing database errors', async () => {
    const marker = 'bxsc_private-marker'
    const error = Object.assign(new Error(`database error ${marker}`), { parameters: [marker] })
    const service = new JobService({ insert: jest.fn().mockRejectedValue(error) } as any, {} as any, {} as any)
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    try {
      let failure: unknown
      try {
        await service.createJob(null, JobType.CREATE_BOX, 'runner', ResourceType.BOX, 'box', {
          secretCredential: { token: marker },
        })
      } catch (caught) {
        failure = caught
      }
      expect(failure).toBeDefined()
      expect(String(failure)).not.toContain(marker)
      expect(JSON.stringify(log.mock.calls)).not.toContain(marker)
    } finally {
      log.mockRestore()
    }
  })

  it.each([JobStatus.COMPLETED, JobStatus.FAILED])('removes credentials in the %s transaction', async (status) => {
    const job = new Job({
      type: JobType.CREATE_BOX,
      runnerId: 'runner',
      resourceType: ResourceType.BOX,
      resourceId: 'box',
      status: JobStatus.IN_PROGRESS,
      payload: JSON.stringify({ image: 'base', secretCredential: { token: 'private' } }),
    })
    const manager = {
      findOne: jest.fn().mockResolvedValue(job),
      save: jest.fn().mockImplementation(async (_type, saved) => saved),
    }
    const handler = { handleJobCompletion: jest.fn().mockResolvedValue(undefined) }
    const service = new JobService(
      { manager: { transaction: (run: any) => run(manager) } } as any,
      {} as any,
      handler as any,
    )
    await service.updateJobStatus(job.id, status)
    expect(manager.save.mock.calls[0][1].getPayload()).toEqual({ image: 'base' })
    expect(job.completedAt).toBeInstanceOf(Date)
  })
})
