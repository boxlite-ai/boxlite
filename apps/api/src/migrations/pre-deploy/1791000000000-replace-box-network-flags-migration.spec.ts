import { QueryRunner } from 'typeorm'
import { ReplaceBoxNetworkFlags1791000000000 } from './1791000000000-replace-box-network-flags-migration'

describe('ReplaceBoxNetworkFlags1791000000000', () => {
  function run() {
    const calls: string[] = []
    const runner = { query: jest.fn((sql: string) => calls.push(sql)) } as unknown as QueryRunner
    return { runner, calls, migration: new ReplaceBoxNetworkFlags1791000000000() }
  }

  it('adds the policy columns with private-inbound, open-outbound defaults', async () => {
    const { runner, calls, migration } = run()
    await migration.up(runner)
    expect(calls).toContain(`ALTER TABLE "box" ADD "inboundEnabled" boolean NOT NULL DEFAULT false`)
    expect(calls).toContain(`ALTER TABLE "box" ADD "outboundEnabled" boolean NOT NULL DEFAULT true`)
    expect(calls).toContain(`ALTER TABLE "box" ADD "outboundAllowNet" text[]`)
  })

  // The backfill is where meaning could flip: public=true is inbound enabled,
  // while blockAll=true is outbound *not* enabled.
  it('backfills each policy column from its flag with the right polarity', async () => {
    const { runner, calls, migration } = run()
    await migration.up(runner)
    const backfill = calls.find((sql) => sql.includes('UPDATE "box" SET'))
    expect(backfill).toContain(`"inboundEnabled" = "public"`)
    expect(backfill).toContain(`"outboundEnabled" = NOT "networkBlockAll"`)
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
        `ALTER TABLE "box" DROP COLUMN "outboundEnabled"`,
        `ALTER TABLE "box" DROP COLUMN "inboundEnabled"`,
      ]),
    )
  })
})
