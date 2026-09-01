import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

type HealthState = 'critical' | 'degraded' | 'healthy' | 'unknown'

class AdminCursorPageDto {
  @ApiPropertyOptional({ nullable: true, description: 'Opaque cursor for the next page' })
  nextCursor: string | null

  @ApiProperty({ minimum: 1, maximum: 200 })
  limit: number
}

@ApiSchema({ name: 'AdminRegionOverview' })
export class AdminRegionOverviewDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  name: string

  @ApiProperty()
  type: string

  @ApiProperty({ enum: ['critical', 'degraded', 'healthy', 'unknown'] })
  state: HealthState

  @ApiProperty()
  runnerCount: number

  @ApiProperty()
  boxCount: number

  @ApiProperty()
  queueDepth: number

  @ApiPropertyOptional({ nullable: true })
  cpuCapacityMillis: number | null

  @ApiPropertyOptional({ nullable: true, description: 'Integer encoded as a decimal string' })
  memoryCapacityBytes: string | null

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  observedAt: string | null
}

@ApiSchema({ name: 'AdminRegionOverviewPage' })
export class AdminRegionOverviewPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminRegionOverviewDto] })
  items: AdminRegionOverviewDto[]
}

@ApiSchema({ name: 'AdminBoxOverview' })
export class AdminBoxOverviewDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  name: string

  @ApiProperty()
  organizationId: string

  @ApiPropertyOptional({ nullable: true })
  runnerId: string | null

  @ApiProperty()
  regionId: string

  @ApiProperty()
  desiredState: string

  @ApiProperty()
  observedState: string

  @ApiProperty({ enum: ['critical', 'degraded', 'healthy', 'unknown'] })
  health: HealthState

  @ApiPropertyOptional({ nullable: true })
  cpuMillis: number | null

  @ApiPropertyOptional({ nullable: true, description: 'Integer encoded as a decimal string' })
  memoryBytes: string | null

  @ApiPropertyOptional({ nullable: true, description: 'Integer encoded as a decimal string' })
  storageBytes: string | null

  @ApiProperty()
  activeJobCount: number

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  observedAt: string | null
}

@ApiSchema({ name: 'AdminBoxOverviewPage' })
export class AdminBoxOverviewPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminBoxOverviewDto] })
  items: AdminBoxOverviewDto[]
}

@ApiSchema({ name: 'AdminBoxJobReference' })
export class AdminBoxJobReferenceDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  type: string
}

@ApiSchema({ name: 'AdminBoxJobReferencePage' })
export class AdminBoxJobReferencePageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminBoxJobReferenceDto] })
  items: AdminBoxJobReferenceDto[]
}

@ApiSchema({ name: 'AdminBoxDetail' })
export class AdminBoxDetailDto extends AdminBoxOverviewDto {
  @ApiProperty({ type: AdminBoxJobReferencePageDto })
  jobs: AdminBoxJobReferencePageDto
}

@ApiSchema({ name: 'AdminJobOverview' })
export class AdminJobOverviewDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  type: string

  @ApiProperty()
  status: string

  @ApiPropertyOptional({ nullable: true })
  runnerId: string | null

  @ApiProperty()
  resourceType: string

  @ApiProperty()
  resourceId: string

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  createdAt: string | null

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  startedAt: string | null

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  finishedAt: string | null

  @ApiPropertyOptional({ nullable: true })
  durationMs: number | null

  @ApiPropertyOptional({ nullable: true, enum: ['capacity', 'network', 'image', 'storage', 'timeout', 'unknown'] })
  errorCategory: string | null

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  observedAt: string | null
}

@ApiSchema({ name: 'AdminJobOverviewPage' })
export class AdminJobOverviewPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminJobOverviewDto] })
  items: AdminJobOverviewDto[]
}

@ApiSchema({ name: 'AdminComponentVersionCount' })
export class AdminComponentVersionCountDto {
  @ApiPropertyOptional({ nullable: true })
  version: string | null

  @ApiProperty()
  count: number
}

@ApiSchema({ name: 'AdminComponentIdentities' })
export class AdminComponentIdentitiesDto {
  @ApiProperty({ type: 'object', properties: { version: { type: 'string', nullable: true } } })
  api: { version: string | null }

  @ApiProperty({ type: [AdminComponentVersionCountDto] })
  runners: AdminComponentVersionCountDto[]

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}

@ApiSchema({ name: 'AdminOrganizationOverview' })
export class AdminOrganizationOverviewDto {
  @ApiProperty()
  organizationId: string

  @ApiProperty()
  name: string

  @ApiProperty()
  memberCount: number

  @ApiProperty()
  boxCount: number

  @ApiProperty({ enum: ['impacted', 'not_impacted'] })
  impactState: 'impacted' | 'not_impacted'

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}

@ApiSchema({ name: 'AdminOrganizationOverviewPage' })
export class AdminOrganizationOverviewPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminOrganizationOverviewDto] })
  items: AdminOrganizationOverviewDto[]

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  observedAt: string | null
}

@ApiSchema({ name: 'AdminOrganizationMember' })
export class AdminOrganizationMemberDto {
  @ApiProperty()
  userId: string

  @ApiProperty()
  email: string

  @ApiProperty()
  displayName: string

  @ApiProperty()
  organizationRole: string

  @ApiProperty({ format: 'date-time' })
  joinedAt: string
}

@ApiSchema({ name: 'AdminOrganizationBox' })
export class AdminOrganizationBoxDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  name: string

  @ApiProperty()
  observedState: string

  @ApiProperty()
  desiredState: string

  @ApiPropertyOptional({ nullable: true })
  runnerId: string | null

  @ApiProperty()
  region: string

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}

@ApiSchema({ name: 'AdminOrganizationMemberPage' })
export class AdminOrganizationMemberPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminOrganizationMemberDto] })
  items: AdminOrganizationMemberDto[]
}

@ApiSchema({ name: 'AdminOrganizationBoxPage' })
export class AdminOrganizationBoxPageDto extends AdminCursorPageDto {
  @ApiProperty({ type: [AdminOrganizationBoxDto] })
  items: AdminOrganizationBoxDto[]
}

@ApiSchema({ name: 'AdminOrganizationImpactEvidence' })
export class AdminOrganizationImpactEvidenceDto {
  @ApiProperty()
  boxId: string

  @ApiProperty({ format: 'date-time' })
  observedAt: string

  @ApiProperty()
  summary: string
}

@ApiSchema({ name: 'AdminOrganizationImpact' })
export class AdminOrganizationImpactDto {
  @ApiProperty({ enum: ['impacted', 'not_impacted'] })
  state: 'impacted' | 'not_impacted'

  @ApiProperty({ type: [AdminOrganizationImpactEvidenceDto] })
  evidence: AdminOrganizationImpactEvidenceDto[]
}

@ApiSchema({ name: 'AdminOrganizationUsage' })
export class AdminOrganizationUsageDto {
  @ApiProperty({ format: 'date-time' })
  periodStart: string

  @ApiProperty({ format: 'date-time' })
  periodEnd: string

  @ApiProperty({ description: 'Integer encoded as a decimal string' })
  computeSeconds: string

  @ApiProperty({ description: 'Integer encoded as a decimal string' })
  storageByteSeconds: string
}

@ApiSchema({ name: 'AdminOrganizationDetail' })
export class AdminOrganizationDetailDto {
  @ApiProperty()
  organizationId: string

  @ApiProperty()
  name: string

  @ApiProperty({ type: AdminOrganizationMemberPageDto })
  members: AdminOrganizationMemberPageDto

  @ApiProperty({ type: AdminOrganizationBoxPageDto })
  boxes: AdminOrganizationBoxPageDto

  @ApiProperty({ type: AdminOrganizationImpactDto })
  impact: AdminOrganizationImpactDto

  @ApiPropertyOptional({ type: AdminOrganizationUsageDto })
  usage?: AdminOrganizationUsageDto

  @ApiProperty({ format: 'date-time' })
  observedAt: string
}
