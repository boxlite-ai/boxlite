import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1741087887225 implements MigrationInterface {
  name = 'Migration1741087887225'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

    await queryRunner.query(`CREATE TYPE "public"."user_role_enum" AS ENUM('admin', 'user')`)
    await queryRunner.query(
      `CREATE TYPE "public"."api_key_permissions_enum" AS ENUM('write:registries', 'delete:registries', 'write:templates', 'delete:templates', 'write:boxes', 'delete:boxes', 'read:volumes', 'write:volumes', 'delete:volumes', 'write:regions', 'delete:regions', 'read:runners', 'write:runners', 'delete:runners', 'read:audit_logs')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."region_regiontype_enum" AS ENUM('shared', 'dedicated', 'custom')`)
    await queryRunner.query(`CREATE TYPE "public"."organization_invitation_role_enum" AS ENUM('owner', 'member')`)
    await queryRunner.query(
      `CREATE TYPE "public"."organization_invitation_status_enum" AS ENUM('pending', 'accepted', 'declined', 'cancelled')`,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."organization_role_permissions_enum" AS ENUM('write:registries', 'delete:registries', 'write:templates', 'delete:templates', 'write:boxes', 'delete:boxes', 'read:volumes', 'write:volumes', 'delete:volumes', 'write:regions', 'delete:regions', 'read:runners', 'write:runners', 'delete:runners', 'read:audit_logs')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."organization_user_role_enum" AS ENUM('owner', 'member')`)
    await queryRunner.query(
      `CREATE TYPE "public"."volume_state_enum" AS ENUM('creating', 'ready', 'pending_create', 'pending_delete', 'deleting', 'deleted', 'error')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."warm_pool_class_enum" AS ENUM('small', 'medium', 'large')`)
    await queryRunner.query(`CREATE TYPE "public"."box_class_enum" AS ENUM('small', 'medium', 'large')`)
    await queryRunner.query(
      `CREATE TYPE "public"."box_state_enum" AS ENUM('creating', 'restoring', 'destroyed', 'destroying', 'started', 'stopped', 'starting', 'stopping', 'error', 'unknown', 'archived', 'archiving', 'resizing')`,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."box_desiredstate_enum" AS ENUM('destroyed', 'started', 'stopped', 'resized')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."runner_class_enum" AS ENUM('small', 'medium', 'large')`)
    await queryRunner.query(
      `CREATE TYPE "public"."runner_state_enum" AS ENUM('initializing', 'ready', 'disabled', 'decommissioned', 'unresponsive')`,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."job_status_enum" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')`,
    )
    await queryRunner.query(`CREATE TYPE "public"."job_resourcetype_enum" AS ENUM('BOX', 'ARTIFACT', 'BACKUP')`)

    await queryRunner.query(
      `CREATE TABLE "user" ("id" character varying NOT NULL, "name" character varying NOT NULL, "email" character varying NOT NULL DEFAULT '', "emailVerified" boolean NOT NULL DEFAULT false, "keyPair" text, "publicKeys" text NOT NULL, "role" "public"."user_role_enum" NOT NULL DEFAULT 'user', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "user_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "api_key" ("organizationId" uuid NOT NULL, "userId" character varying NOT NULL, "name" character varying NOT NULL, "keyHash" character varying NOT NULL DEFAULT '', "keyPrefix" character varying NOT NULL DEFAULT '', "keySuffix" character varying NOT NULL DEFAULT '', "permissions" "public"."api_key_permissions_enum" array NOT NULL, "createdAt" TIMESTAMP NOT NULL, "lastUsedAt" TIMESTAMP, "expiresAt" TIMESTAMP, CONSTRAINT "api_key_keyHash_unique" UNIQUE ("keyHash"), CONSTRAINT "api_key_organizationId_userId_name_pk" PRIMARY KEY ("organizationId", "userId", "name"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "webhook_initialization" ("organizationId" character varying NOT NULL, "svixApplicationId" character varying, "lastError" text, "retryCount" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "webhook_initialization_organizationId_pk" PRIMARY KEY ("organizationId"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "region" ("id" character varying NOT NULL, "name" character varying NOT NULL, "organizationId" uuid, "regionType" "public"."region_regiontype_enum" NOT NULL, "enforceQuotas" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "proxyUrl" character varying, "toolboxProxyUrl" character varying, "proxyApiKeyHash" character varying, "sshGatewayUrl" character varying, "sshGatewayApiKeyHash" character varying, CONSTRAINT "region_not_custom" CHECK ("organizationId" IS NOT NULL OR "regionType" != 'custom'), CONSTRAINT "region_not_shared" CHECK ("organizationId" IS NULL OR "regionType" != 'shared'), CONSTRAINT "region_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "createdBy" character varying NOT NULL, "telemetryEnabled" boolean NOT NULL DEFAULT true, "defaultRegionId" character varying, "max_cpu_per_box" integer NOT NULL DEFAULT '4', "max_memory_per_box" integer NOT NULL DEFAULT '8', "max_disk_per_box" integer NOT NULL DEFAULT '10', "authenticated_rate_limit" integer, "box_create_rate_limit" integer, "box_lifecycle_rate_limit" integer, "authenticated_rate_limit_ttl_seconds" integer, "box_create_rate_limit_ttl_seconds" integer, "box_lifecycle_rate_limit_ttl_seconds" integer, "suspended" boolean NOT NULL DEFAULT false, "suspendedAt" TIMESTAMP WITH TIME ZONE, "suspensionReason" character varying, "suspensionCleanupGracePeriodHours" integer NOT NULL DEFAULT '24', "suspendedUntil" TIMESTAMP WITH TIME ZONE, "template_deactivation_timeout_minutes" integer NOT NULL DEFAULT '20160', "boxLimitedNetworkEgress" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "experimentalConfig" jsonb, CONSTRAINT "organization_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_role" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "description" character varying NOT NULL, "permissions" "public"."organization_role_permissions_enum" array NOT NULL, "isGlobal" boolean NOT NULL DEFAULT false, "organizationId" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "organization_role_id_pk" PRIMARY KEY ("id"), CONSTRAINT "organization_role_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_invitation" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid NOT NULL, "email" character varying NOT NULL, "invitedBy" character varying NOT NULL DEFAULT '', "role" "public"."organization_invitation_role_enum" NOT NULL DEFAULT 'member', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "status" "public"."organization_invitation_status_enum" NOT NULL DEFAULT 'pending', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "organization_invitation_id_pk" PRIMARY KEY ("id"), CONSTRAINT "organization_invitation_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_user" ("organizationId" uuid NOT NULL, "userId" character varying NOT NULL, "role" "public"."organization_user_role_enum" NOT NULL DEFAULT 'member', "isDefaultForUser" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "organization_user_organizationId_userId_pk" PRIMARY KEY ("organizationId", "userId"), CONSTRAINT "organization_user_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "volume" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid, "name" character varying NOT NULL, "state" "public"."volume_state_enum" NOT NULL DEFAULT 'pending_create', "errorReason" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastUsedAt" TIMESTAMP, CONSTRAINT "volume_organizationId_name_unique" UNIQUE ("organizationId", "name"), CONSTRAINT "volume_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "warm_pool" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "pool" integer NOT NULL, "image" character varying NOT NULL, "target" character varying NOT NULL, "cpu" integer NOT NULL, "mem" integer NOT NULL, "disk" integer NOT NULL, "gpu" integer NOT NULL, "gpuType" character varying NOT NULL, "class" "public"."warm_pool_class_enum" NOT NULL DEFAULT 'small', "osUser" character varying NOT NULL, "errorReason" character varying, "env" text NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "warm_pool_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "box" ("id" character varying NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying(12) NOT NULL, "organizationId" uuid NOT NULL, "name" character varying NOT NULL, "region" character varying NOT NULL, "image" character varying, "runnerId" uuid, "prevRunnerId" uuid, "class" "public"."box_class_enum" NOT NULL DEFAULT 'small', "state" "public"."box_state_enum" NOT NULL DEFAULT 'unknown', "desiredState" "public"."box_desiredstate_enum" NOT NULL DEFAULT 'started', "osUser" character varying NOT NULL, "errorReason" character varying, "recoverable" boolean NOT NULL DEFAULT false, "env" jsonb NOT NULL DEFAULT '{}', "public" boolean NOT NULL DEFAULT false, "networkBlockAll" boolean NOT NULL DEFAULT false, "networkAllowList" character varying, "labels" jsonb, "cpu" integer NOT NULL DEFAULT '2', "gpu" integer NOT NULL DEFAULT '0', "mem" integer NOT NULL DEFAULT '4', "disk" integer NOT NULL DEFAULT '10', "volumes" jsonb NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "autoStopInterval" integer NOT NULL DEFAULT '15', "autoDeleteInterval" integer NOT NULL DEFAULT '-1', "pending" boolean NOT NULL DEFAULT false, "authToken" character varying NOT NULL, "daemonVersion" character varying, CONSTRAINT "box_organizationId_name_unique" UNIQUE ("organizationId", "name"), CONSTRAINT "box_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "box_last_activity" ("boxId" character varying NOT NULL, "lastActivityAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "box_last_activity_boxId_pk" PRIMARY KEY ("boxId"), CONSTRAINT "box_last_activity_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "ssh_access" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying NOT NULL, "token" text NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "ssh_access_id_pk" PRIMARY KEY ("id"), CONSTRAINT "ssh_access_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "runner" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "domain" character varying, "apiUrl" character varying, "proxyUrl" character varying, "apiKey" character varying NOT NULL, "cpu" double precision NOT NULL DEFAULT '0', "memoryGiB" double precision NOT NULL DEFAULT '0', "diskGiB" double precision NOT NULL DEFAULT '0', "gpu" integer, "gpuType" character varying, "class" "public"."runner_class_enum" NOT NULL DEFAULT 'small', "currentCpuLoadAverage" double precision NOT NULL DEFAULT '0', "currentCpuUsagePercentage" double precision NOT NULL DEFAULT '0', "currentMemoryUsagePercentage" double precision NOT NULL DEFAULT '0', "currentDiskUsagePercentage" double precision NOT NULL DEFAULT '0', "currentAllocatedCpu" double precision NOT NULL DEFAULT '0', "currentAllocatedMemoryGiB" double precision NOT NULL DEFAULT '0', "currentAllocatedDiskGiB" double precision NOT NULL DEFAULT '0', "currentStartedBoxes" integer NOT NULL DEFAULT '0', "availabilityScore" integer NOT NULL DEFAULT '0', "region" character varying NOT NULL, "name" character varying NOT NULL, "state" "public"."runner_state_enum" NOT NULL DEFAULT 'initializing', "appVersion" character varying DEFAULT 'v0.0.0-dev', "apiVersion" character varying NOT NULL DEFAULT '0', "lastChecked" TIMESTAMP WITH TIME ZONE, "unschedulable" boolean NOT NULL DEFAULT false, "draining" boolean NOT NULL DEFAULT false, "serviceHealth" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "runner_region_name_unique" UNIQUE ("region", "name"), CONSTRAINT "runner_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "job" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "version" integer NOT NULL, "type" character varying NOT NULL, "status" "public"."job_status_enum" NOT NULL DEFAULT 'PENDING', "runnerId" character varying NOT NULL, "resourceType" "public"."job_resourcetype_enum" NOT NULL, "resourceId" character varying NOT NULL, "payload" character varying, "resultMetadata" character varying, "traceContext" jsonb, "errorMessage" text, "startedAt" TIMESTAMP WITH TIME ZONE, "completedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "job_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "audit_log" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actorId" character varying NOT NULL, "actorEmail" character varying NOT NULL DEFAULT '', "organizationId" character varying, "action" character varying NOT NULL, "targetType" character varying, "targetId" character varying, "statusCode" integer, "errorMessage" character varying, "ipAddress" character varying, "userAgent" text, "source" character varying, "metadata" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "audit_log_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_role_assignment_invitation" ("invitationId" uuid NOT NULL, "roleId" uuid NOT NULL, CONSTRAINT "organization_role_assignment_invitation_invitationId_roleId_pk" PRIMARY KEY ("invitationId", "roleId"), CONSTRAINT "organization_role_assignment_invitation_invitationId_fk" FOREIGN KEY ("invitationId") REFERENCES "organization_invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "organization_role_assignment_invitation_roleId_fk" FOREIGN KEY ("roleId") REFERENCES "organization_role"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_role_assignment" ("organizationId" uuid NOT NULL, "userId" character varying NOT NULL, "roleId" uuid NOT NULL, CONSTRAINT "organization_role_assignment_organizationId_userId_roleId_pk" PRIMARY KEY ("organizationId", "userId", "roleId"), CONSTRAINT "organization_role_assignment_organizationId_userId_fk" FOREIGN KEY ("organizationId", "userId") REFERENCES "organization_user"("organizationId","userId") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "organization_role_assignment_roleId_fk" FOREIGN KEY ("roleId") REFERENCES "organization_role"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)`,
    )

    await queryRunner.query(`CREATE INDEX "api_key_org_user_idx" ON "api_key" ("organizationId", "userId")`)
    await queryRunner.query(
      `CREATE INDEX "idx_region_custom" ON "region" ("organizationId") WHERE "regionType" = 'custom'`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "region_sshGatewayApiKeyHash_unique" ON "region" ("sshGatewayApiKeyHash") WHERE "sshGatewayApiKeyHash" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "region_proxyApiKeyHash_unique" ON "region" ("proxyApiKeyHash") WHERE "proxyApiKeyHash" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "region_organizationId_null_name_unique" ON "region" ("name") WHERE "organizationId" IS NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "region_organizationId_name_unique" ON "region" ("organizationId", "name") WHERE "organizationId" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "organization_user_default_user_unique" ON "organization_user" ("userId") WHERE "isDefaultForUser" = true`,
    )
    await queryRunner.query(
      `CREATE INDEX "warm_pool_find_idx" ON "warm_pool" ("image", "target", "class", "cpu", "mem", "disk", "gpu", "osUser", "env")`,
    )
    await queryRunner.query(`CREATE INDEX "idx_box_authtoken" ON "box" ("authToken")`)
    await queryRunner.query(`CREATE INDEX "box_image_idx" ON "box" ("image")`)
    await queryRunner.query(`CREATE INDEX "box_pending_idx" ON "box" ("id") WHERE "pending" = true`)
    await queryRunner.query(
      `CREATE INDEX "box_active_only_idx" ON "box" ("id") WHERE "state" <> ALL (ARRAY['destroyed'::box_state_enum, 'archived'::box_state_enum])`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_runner_state_desired_idx" ON "box" ("runnerId", "state", "desiredState") WHERE "pending" = false`,
    )
    await queryRunner.query(`CREATE INDEX "box_resources_idx" ON "box" ("cpu", "mem", "disk", "gpu")`)
    await queryRunner.query(`CREATE INDEX "box_region_idx" ON "box" ("region")`)
    await queryRunner.query(`CREATE INDEX "box_organizationid_boxid_idx" ON "box" ("organizationId", "boxId")`)
    await queryRunner.query(`CREATE INDEX "box_organizationid_idx" ON "box" ("organizationId")`)
    await queryRunner.query(`CREATE INDEX "box_runner_state_idx" ON "box" ("runnerId", "state")`)
    await queryRunner.query(`CREATE INDEX "box_runnerid_idx" ON "box" ("runnerId")`)
    await queryRunner.query(`CREATE INDEX "box_desiredstate_idx" ON "box" ("desiredState")`)
    await queryRunner.query(`CREATE INDEX "box_state_idx" ON "box" ("state")`)
    await queryRunner.query(`CREATE UNIQUE INDEX "box_boxid_unique_idx" ON "box" ("boxId")`)
    await queryRunner.query(`CREATE INDEX "box_labels_gin_full_idx" ON "box" USING gin ("labels" jsonb_path_ops)`)
    await queryRunner.query(`CREATE INDEX "idx_box_volumes_gin" ON "box" USING gin ("volumes" jsonb_path_ops)`)
    await queryRunner.query(
      `CREATE INDEX "runner_state_unschedulable_region_index" ON "runner" ("state", "unschedulable", "region")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_BACKUP_JOB" ON "job" ("resourceType", "resourceId", "runnerId") WHERE "completedAt" IS NULL AND "type" = 'CREATE_BACKUP'`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_UNIQUE_INCOMPLETE_JOB" ON "job" ("resourceType", "resourceId", "runnerId") WHERE "completedAt" IS NULL AND "type" != 'CREATE_BACKUP'`,
    )
    await queryRunner.query(`CREATE INDEX "job_resourceType_resourceId_index" ON "job" ("resourceType", "resourceId")`)
    await queryRunner.query(`CREATE INDEX "job_status_createdAt_index" ON "job" ("status", "createdAt")`)
    await queryRunner.query(`CREATE INDEX "job_runnerId_status_index" ON "job" ("runnerId", "status")`)
    await queryRunner.query(
      `CREATE INDEX "audit_log_organizationId_createdAt_index" ON "audit_log" ("organizationId", "createdAt")`,
    )
    await queryRunner.query(`CREATE INDEX "audit_log_createdAt_index" ON "audit_log" ("createdAt")`)
    await queryRunner.query(
      `CREATE INDEX "organization_role_assignment_invitation_invitationId_index" ON "organization_role_assignment_invitation" ("invitationId")`,
    )
    await queryRunner.query(
      `CREATE INDEX "organization_role_assignment_invitation_roleId_index" ON "organization_role_assignment_invitation" ("roleId")`,
    )
    await queryRunner.query(
      `CREATE INDEX "organization_role_assignment_organizationId_userId_index" ON "organization_role_assignment" ("organizationId", "userId")`,
    )
    await queryRunner.query(
      `CREATE INDEX "organization_role_assignment_roleId_index" ON "organization_role_assignment" ("roleId")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."organization_role_assignment_roleId_index"`)
    await queryRunner.query(`DROP INDEX "public"."organization_role_assignment_organizationId_userId_index"`)
    await queryRunner.query(`DROP TABLE "organization_role_assignment"`)
    await queryRunner.query(`DROP INDEX "public"."organization_role_assignment_invitation_roleId_index"`)
    await queryRunner.query(`DROP INDEX "public"."organization_role_assignment_invitation_invitationId_index"`)
    await queryRunner.query(`DROP TABLE "organization_role_assignment_invitation"`)
    await queryRunner.query(`DROP INDEX "public"."audit_log_createdAt_index"`)
    await queryRunner.query(`DROP INDEX "public"."audit_log_organizationId_createdAt_index"`)
    await queryRunner.query(`DROP TABLE "audit_log"`)
    await queryRunner.query(`DROP INDEX "public"."job_runnerId_status_index"`)
    await queryRunner.query(`DROP INDEX "public"."job_status_createdAt_index"`)
    await queryRunner.query(`DROP INDEX "public"."job_resourceType_resourceId_index"`)
    await queryRunner.query(`DROP INDEX "public"."IDX_UNIQUE_INCOMPLETE_JOB"`)
    await queryRunner.query(`DROP INDEX "public"."IDX_UNIQUE_INCOMPLETE_BACKUP_JOB"`)
    await queryRunner.query(`DROP TABLE "job"`)
    await queryRunner.query(`DROP TYPE "public"."job_resourcetype_enum"`)
    await queryRunner.query(`DROP TYPE "public"."job_status_enum"`)
    await queryRunner.query(`DROP INDEX "public"."runner_state_unschedulable_region_index"`)
    await queryRunner.query(`DROP TABLE "runner"`)
    await queryRunner.query(`DROP TYPE "public"."runner_state_enum"`)
    await queryRunner.query(`DROP TYPE "public"."runner_class_enum"`)
    await queryRunner.query(`DROP TABLE "ssh_access"`)
    await queryRunner.query(`DROP TABLE "box_last_activity"`)
    await queryRunner.query(`DROP INDEX "public"."idx_box_volumes_gin"`)
    await queryRunner.query(`DROP INDEX "public"."box_labels_gin_full_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_boxid_unique_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_state_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_desiredstate_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_runnerid_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_runner_state_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_organizationid_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_organizationid_boxid_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_region_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_resources_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_runner_state_desired_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_active_only_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_pending_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_image_idx"`)
    await queryRunner.query(`DROP INDEX "public"."idx_box_authtoken"`)
    await queryRunner.query(`DROP TABLE "box"`)
    await queryRunner.query(`DROP TYPE "public"."box_desiredstate_enum"`)
    await queryRunner.query(`DROP TYPE "public"."box_state_enum"`)
    await queryRunner.query(`DROP TYPE "public"."box_class_enum"`)
    await queryRunner.query(`DROP INDEX "public"."warm_pool_find_idx"`)
    await queryRunner.query(`DROP TABLE "warm_pool"`)
    await queryRunner.query(`DROP TYPE "public"."warm_pool_class_enum"`)
    await queryRunner.query(`DROP TABLE "volume"`)
    await queryRunner.query(`DROP TYPE "public"."volume_state_enum"`)
    await queryRunner.query(`DROP INDEX "public"."organization_user_default_user_unique"`)
    await queryRunner.query(`DROP TABLE "organization_user"`)
    await queryRunner.query(`DROP TYPE "public"."organization_user_role_enum"`)
    await queryRunner.query(`DROP TABLE "organization_invitation"`)
    await queryRunner.query(`DROP TYPE "public"."organization_invitation_status_enum"`)
    await queryRunner.query(`DROP TYPE "public"."organization_invitation_role_enum"`)
    await queryRunner.query(`DROP TABLE "organization_role"`)
    await queryRunner.query(`DROP TYPE "public"."organization_role_permissions_enum"`)
    await queryRunner.query(`DROP TABLE "organization"`)
    await queryRunner.query(`DROP INDEX "public"."region_organizationId_name_unique"`)
    await queryRunner.query(`DROP INDEX "public"."region_organizationId_null_name_unique"`)
    await queryRunner.query(`DROP INDEX "public"."region_proxyApiKeyHash_unique"`)
    await queryRunner.query(`DROP INDEX "public"."region_sshGatewayApiKeyHash_unique"`)
    await queryRunner.query(`DROP INDEX "public"."idx_region_custom"`)
    await queryRunner.query(`DROP TABLE "region"`)
    await queryRunner.query(`DROP TYPE "public"."region_regiontype_enum"`)
    await queryRunner.query(`DROP TABLE "webhook_initialization"`)
    await queryRunner.query(`DROP INDEX "public"."api_key_org_user_idx"`)
    await queryRunner.query(`DROP TABLE "api_key"`)
    await queryRunner.query(`DROP TYPE "public"."api_key_permissions_enum"`)
    await queryRunner.query(`DROP TABLE "user"`)
    await queryRunner.query(`DROP TYPE "public"."user_role_enum"`)
  }
}
