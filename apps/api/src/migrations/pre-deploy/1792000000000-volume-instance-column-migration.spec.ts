import { QueryRunner } from 'typeorm'
import { VolumeInstanceColumn1792000000000 } from './1792000000000-volume-instance-column-migration'

describe('VolumeInstanceColumn1792000000000', () => {
  it('adds the instance column idempotently', async () => {
    const calls: string[] = []
    const runner = { query: jest.fn((sql: string) => calls.push(sql)) } as unknown as QueryRunner

    const migration = new VolumeInstanceColumn1792000000000()
    await migration.up(runner)
    await migration.up(runner)

    expect(calls).toContain(`ALTER TABLE "volume" ADD COLUMN IF NOT EXISTS "instance" character varying`)
    expect(calls.filter((sql) => sql.includes('ADD COLUMN'))).toHaveLength(2)
  })
})
