import { NotFoundException } from '@nestjs/common'
import type { EntityManager } from 'typeorm'

export async function appForEnvironment(
  manager: EntityManager,
  organizationId: string,
  environmentId: string,
): Promise<string> {
  const [app] = await manager.query(
    `SELECT a.id FROM cloud_app.apps a JOIN cloud_app.envs e ON e.app_id = a.id
     WHERE a.org_id = $1 AND e.id = $2 AND a.deleted_at IS NULL`,
    [organizationId, environmentId],
  )
  if (!app) throw new NotFoundException('App environment not found')
  return app.id
}
