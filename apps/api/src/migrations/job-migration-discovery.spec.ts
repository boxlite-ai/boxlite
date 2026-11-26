import migrationSource from './data-source'
import { MigrationDataSource } from './migration-data-source'
import preDeploySource from './pre-deploy/data-source'

class MigrationDiscovery extends MigrationDataSource {
  async migrationNames(): Promise<string[]> {
    await this.buildMetadatas()
    return this.migrations.map((migration) => migration.name ?? migration.constructor.name)
  }
}

describe('V2 job lock migration discovery', () => {
  it.each([
    ['combined', migrationSource],
    ['pre-deploy', preDeploySource],
  ] as const)(
    'loads the job lock migration in the %s migration set',
    async (_, source) => {
      const discovery = new MigrationDiscovery({ ...source.options, entities: [] })

      await expect(discovery.migrationNames()).resolves.toContain('AddJobStateChangeLockOwner1795628000000')
    },
    20_000,
  )
})
