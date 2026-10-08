import { QueryRunner } from 'typeorm'
import { AddTunnelTable1790294400000 } from './1790294400000-add-tunnel-table-migration'

describe('AddTunnelTable1790294400000', () => {
  it('creates box-scoped ports and drops the table on rollback', async () => {
    const runner = { query: jest.fn() } as unknown as QueryRunner
    const migration = new AddTunnelTable1790294400000()

    await migration.up(runner)
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('UNIQUE ("box_id", "port")'))
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('ON DELETE CASCADE'))

    await migration.down(runner)
    expect(runner.query).toHaveBeenLastCalledWith('DROP TABLE "tunnel"')
  })
})
