import { AddApiHotPathIndexes1795737600000 } from './1795737600000-add-api-hot-path-indexes-migration'

describe('AddApiHotPathIndexes1795737600000', () => {
  it('drops an invalid leftover index before rebuilding all hot-path indexes', async () => {
    const queryRunner = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ indisvalid: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue([]),
    }
    const migration = new AddApiHotPathIndexes1795737600000()

    await migration.up(queryRunner as never)

    expect(queryRunner.query).toHaveBeenNthCalledWith(
      1,
      'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)',
      ['idx_runner_api_key'],
    )
    expect(queryRunner.query).toHaveBeenNthCalledWith(2, 'DROP INDEX CONCURRENTLY idx_runner_api_key')
    expect(queryRunner.query).toHaveBeenNthCalledWith(
      3,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runner_api_key ON runner ("apiKey")',
    )
    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('idx_job_runner_status_created_at'))
    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('idx_job_in_progress_updated_at'))
    expect(queryRunner.query).toHaveBeenCalledWith(expect.stringContaining('idx_job_resource_created_at'))
  })
})
