import { QueryRunner } from 'typeorm'
import { RetireUnusedJobTypes1786300000000 } from './1786300000000-retire-unused-job-types-migration'

describe('RetireUnusedJobTypes1786300000000', () => {
  it('restores legacy resizing boxes before terminalizing unsupported jobs', async () => {
    const query = jest.fn().mockResolvedValue(undefined)
    const migration = new RetireUnusedJobTypes1786300000000()

    await migration.up({ query } as unknown as QueryRunner)

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][0]).toContain(`UPDATE "box" SET "state" = CASE "desiredState"`)
    expect(query.mock.calls[0][0]).toContain(`"pending" = false`)
    expect(query.mock.calls[0][0]).toContain(`WHERE "state" = 'resizing'`)
    expect(query.mock.calls[0][0]).toContain(`"job"."type" = 'RESIZE_BOX'`)
    expect(query.mock.calls[1][0]).toContain(`UPDATE "job" SET "status" = 'FAILED'`)
    expect(query.mock.calls[1][0]).toContain(`'UPDATE_BOX_NETWORK_SETTINGS'`)
  })
})
