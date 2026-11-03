import { QueryRunner } from 'typeorm'
import { AddDomain1792972800000 } from './1792972800000-add-domain-migration'

describe('AddDomain1792972800000', () => {
  it('adds the organization allowance and a unique hostname with a box port target, and drops both on rollback', async () => {
    const runner = { query: jest.fn() } as unknown as QueryRunner
    const migration = new AddDomain1792972800000()

    await migration.up(runner)
    expect(runner.query).toHaveBeenCalledWith(
      expect.stringContaining('ADD "domain_count_limit" integer NOT NULL DEFAULT 1'),
    )
    expect(runner.query).toHaveBeenCalledWith(expect.stringContaining('UNIQUE ("hostname")'))
    // Several names may share a port, so the target is indexed, not unique.
    expect(runner.query).not.toHaveBeenCalledWith(expect.stringContaining('UNIQUE ("box_id"'))
    // Target references survive physical Box cleanup; explicit unbind clears them.
    expect(runner.query).not.toHaveBeenCalledWith(expect.stringContaining('REFERENCES "box"'))

    await migration.down(runner)
    expect(runner.query).toHaveBeenNthCalledWith(6, 'DROP TABLE "domain"')
    expect(runner.query).toHaveBeenLastCalledWith('ALTER TABLE "organization" DROP COLUMN "domain_count_limit"')
  })
})
