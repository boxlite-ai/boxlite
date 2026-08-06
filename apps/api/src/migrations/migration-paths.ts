import { join } from 'path'

/**
 * Migrations an API process may run during startup.
 *
 * Post-deploy work is intentionally absent: it can contain deferred scans or
 * contract changes and must run only through migration:run:post-deploy after a
 * rolling deployment has completed.
 */
export const apiStartupMigrationPaths = (applicationRoot: string): string[] => [
  join(applicationRoot, 'migrations/*-migration.{ts,js}'),
  join(applicationRoot, 'migrations/pre-deploy/*-migration.{ts,js}'),
]
