import { QueryRunner } from 'typeorm'
import { ReplaceBoxNetworkFlags1790400000000 } from './1790400000000-replace-box-network-flags-migration'

describe('ReplaceBoxNetworkFlags1790400000000', () => {
  function run() {
    const calls: string[] = []
    const runner = { query: jest.fn((sql: string) => calls.push(sql)) } as unknown as QueryRunner
    return { runner, calls, migration: new ReplaceBoxNetworkFlags1790400000000() }
  }

  it('adds the policy columns with private-inbound, open-outbound defaults', async () => {
    const { runner, calls, migration } = run()
    await migration.up(runner)
    expect(calls).toContain(`ALTER TABLE "box" ADD "inboundMode" character varying NOT NULL DEFAULT 'disabled'`)
    expect(calls).toContain(`ALTER TABLE "box" ADD "outboundMode" character varying NOT NULL DEFAULT 'enabled'`)
    expect(calls).toContain(`ALTER TABLE "box" ADD "outboundAllowNet" text[]`)
  })

  // The backfill is where meaning could flip: public=true is inbound enabled,
  // while blockAll=true is outbound *disabled*.
  it('backfills each policy column from its flag with the right polarity', async () => {
    const { runner, calls, migration } = run()
    await migration.up(runner)
    const backfill = calls.find((sql) => sql.includes('UPDATE "box" SET'))
    expect(backfill).toContain(`"inboundMode" = CASE WHEN "public" THEN 'enabled' ELSE 'disabled' END`)
    expect(backfill).toContain(`"outboundMode" = CASE WHEN "networkBlockAll" THEN 'disabled' ELSE 'enabled' END`)
    expect(backfill).toContain(`"outboundAllowNet" = box_allow_net_from_list("networkAllowList")`)
    expect(calls.findIndex((sql) => sql.includes('FUNCTION box_allow_net_from_list'))).toBeLessThan(
      calls.indexOf(backfill as string),
    )
  })

  it('installs a before-row trigger so old and new API writes stay equal', async () => {
    const { runner, calls, migration } = run()
    await migration.up(runner)
    expect(calls.find((sql) => sql.includes('CREATE TRIGGER box_network_policy_sync'))).toContain(
      'BEFORE INSERT OR UPDATE ON "box"',
    )
  })

  it('drops the trigger before the columns on rollback', async () => {
    const { runner, calls, migration } = run()
    await migration.down(runner)
    expect(calls[0]).toContain('DROP TRIGGER IF EXISTS box_network_policy_sync')
    expect(calls.slice(2)).toEqual(
      expect.arrayContaining([
        `ALTER TABLE "box" DROP COLUMN "outboundAllowNet"`,
        `ALTER TABLE "box" DROP COLUMN "outboundMode"`,
        `ALTER TABLE "box" DROP COLUMN "inboundMode"`,
      ]),
    )
  })
})
