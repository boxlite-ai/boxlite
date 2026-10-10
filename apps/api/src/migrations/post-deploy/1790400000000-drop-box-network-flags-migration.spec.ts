import { QueryRunner } from 'typeorm'
import { DropBoxNetworkFlags1790400000000 } from './1790400000000-drop-box-network-flags-migration'

describe('DropBoxNetworkFlags1790400000000', () => {
  it('removes the sync trigger, then the flag columns, idempotently', async () => {
    const calls: string[] = []
    const runner = { query: jest.fn((sql: string) => calls.push(sql)) } as unknown as QueryRunner

    const migration = new DropBoxNetworkFlags1790400000000()
    await migration.up(runner)
    await migration.up(runner)

    expect(calls[0]).toBe(`DROP TRIGGER IF EXISTS box_network_policy_sync ON "box"`)
    expect(calls).toContain(`ALTER TABLE "box" DROP COLUMN IF EXISTS "public"`)
    expect(calls).toContain(`ALTER TABLE "box" DROP COLUMN IF EXISTS "networkBlockAll"`)
    expect(calls).toContain(`ALTER TABLE "box" DROP COLUMN IF EXISTS "networkAllowList"`)
    expect(calls.filter((sql) => sql.includes('DROP COLUMN'))).toHaveLength(6)
  })
})
