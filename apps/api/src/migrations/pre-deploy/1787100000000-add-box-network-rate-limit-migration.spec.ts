import { QueryRunner } from 'typeorm'
import { AddBoxNetworkRateLimit1787100000000 } from './1787100000000-add-box-network-rate-limit-migration'

describe('AddBoxNetworkRateLimit1787100000000', () => {
  it('adds one nullable integer column per direction', async () => {
    const query = jest.fn().mockResolvedValue(undefined)

    await new AddBoxNetworkRateLimit1787100000000().up({ query } as unknown as QueryRunner)

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      `ALTER TABLE "box" ADD "networkTxKbps" integer`,
      `ALTER TABLE "box" ADD "networkRxKbps" integer`,
    ])
  })

  it('drops both columns on the way down', async () => {
    const query = jest.fn().mockResolvedValue(undefined)

    await new AddBoxNetworkRateLimit1787100000000().down({ query } as unknown as QueryRunner)

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      `ALTER TABLE "box" DROP COLUMN "networkRxKbps"`,
      `ALTER TABLE "box" DROP COLUMN "networkTxKbps"`,
    ])
  })
})
