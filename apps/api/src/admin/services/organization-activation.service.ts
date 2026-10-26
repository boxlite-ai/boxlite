import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { AdminOrganizationActivationDto } from '../dto/organization-activation.dto'

type ActivationRow = {
  organizationId: string
  lastBoxCreatedAt: Date | null
  lastBoxModifiedAt: Date | null
  observedAt: Date
}

@Injectable()
export class AdminOrganizationActivationService {
  constructor(private readonly dataSource: DataSource) {}

  async get(organizationId: string): Promise<AdminOrganizationActivationDto | null> {
    const [row]: ActivationRow[] = await this.dataSource.query(
      `SELECT organization.id AS "organizationId", facts."lastBoxCreatedAt",
        facts."lastBoxModifiedAt", statement_timestamp() AS "observedAt"
       FROM organization LEFT JOIN organization_activation_facts facts ON facts."organizationId" = organization.id
       WHERE organization.id = $1::uuid`,
      [organizationId],
    )
    return row
      ? {
          organizationId: row.organizationId,
          lastBoxCreatedAt: row.lastBoxCreatedAt?.toISOString() ?? null,
          lastBoxModifiedAt: row.lastBoxModifiedAt?.toISOString() ?? null,
          observedAt: row.observedAt.toISOString(),
        }
      : null
  }
}
