#!/usr/bin/env node

import pg from 'pg'

const { Client } = pg
const APPLY = process.argv.includes('--apply')

const REQUIRED_ENV = ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE']
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name])
if (missingEnv.length > 0) {
  console.error(`Missing DB env: ${missingEnv.join(', ')}`)
  process.exit(2)
}

const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || '5432'),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  ssl:
    process.env.DB_TLS_ENABLED === 'true'
      ? { rejectUnauthorized: process.env.DB_TLS_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
})

const organizationColumns = [
  legacyRename('organization', 'max_snapshot_size', 'max_template_size'),
  legacyRename('organization', 'snapshot_quota', 'template_quota'),
  legacyRename('organization', 'snapshot_deactivation_timeout_minutes', 'template_deactivation_timeout_minutes'),
  addColumn('organization', 'defaultRegionId', 'character varying'),
  addColumn('organization', 'max_cpu_per_sandbox', "integer NOT NULL DEFAULT '4'"),
  addColumn('organization', 'max_memory_per_sandbox', "integer NOT NULL DEFAULT '8'"),
  addColumn('organization', 'max_disk_per_sandbox', "integer NOT NULL DEFAULT '10'"),
  addColumn('organization', 'max_template_size', "integer NOT NULL DEFAULT '20'", ['max_snapshot_size']),
  addColumn('organization', 'template_quota', "integer NOT NULL DEFAULT '100'", ['snapshot_quota']),
  addColumn('organization', 'volume_quota', "integer NOT NULL DEFAULT '100'"),
  addColumn('organization', 'authenticated_rate_limit', 'integer'),
  addColumn('organization', 'sandbox_create_rate_limit', 'integer'),
  addColumn('organization', 'sandbox_lifecycle_rate_limit', 'integer'),
  addColumn('organization', 'authenticated_rate_limit_ttl_seconds', 'integer'),
  addColumn('organization', 'sandbox_create_rate_limit_ttl_seconds', 'integer'),
  addColumn('organization', 'sandbox_lifecycle_rate_limit_ttl_seconds', 'integer'),
  addColumn('organization', 'suspended', 'boolean NOT NULL DEFAULT false'),
  addColumn('organization', 'suspendedAt', 'TIMESTAMP WITH TIME ZONE'),
  addColumn('organization', 'suspensionReason', 'character varying'),
  addColumn('organization', 'suspensionCleanupGracePeriodHours', "integer NOT NULL DEFAULT '24'"),
  addColumn('organization', 'suspendedUntil', 'TIMESTAMP WITH TIME ZONE'),
  addColumn('organization', 'template_deactivation_timeout_minutes', "integer NOT NULL DEFAULT '20160'", [
    'snapshot_deactivation_timeout_minutes',
  ]),
  addColumn('organization', 'sandboxLimitedNetworkEgress', 'boolean NOT NULL DEFAULT false'),
  addColumn('organization', 'experimentalConfig', 'jsonb'),
]

const templateSchema = [
  ensureUuidOssp(),
  renameTable('snapshot', 'box_template'),
  renameTable('snapshot_region', 'box_template_region'),
  ensureEnum('box_template_state_enum', [
    'building',
    'pending',
    'pulling',
    'active',
    'inactive',
    'error',
    'build_failed',
    'removing',
  ]),
  ensureBoxTemplateTable(),
  ensureBoxTemplateRegionTable(),
  addColumn('box_template', 'buildInfoArtifactRef', 'character varying'),
  addColumn('box_template', 'initialRunnerId', 'character varying'),
  addIndex('box_template_name_idx', 'box_template', ['name']),
  addIndex('box_template_state_idx', 'box_template', ['state']),
  addIndex('sandbox_template_idx', 'sandbox', ['template']),
]

const warmPoolSchema = [
  legacyRename('warm_pool', 'image', 'template'),
  addColumn('warm_pool', 'template', 'character varying NOT NULL DEFAULT \'boxlite/base\'', ['image']),
  addIndex('warm_pool_find_idx', 'warm_pool', ['template', 'target', 'class', 'cpu', 'mem', 'disk', 'gpu', 'osUser', 'env']),
]

try {
  await client.connect()
  assertApplyIsExplicit()

  const before = await audit()
  printAudit('before', before)

  const steps = [...organizationColumns, ...templateSchema, ...warmPoolSchema]
  const planned = []

  if (APPLY) {
    await client.query('BEGIN')
  }

  for (const step of steps) {
    const needed = await step.needed()
    if (!needed) continue

    planned.push(step.label)
    if (APPLY) {
      await client.query(step.sql)
    }
  }

  if (APPLY) {
    await client.query('COMMIT')
  }

  console.log('')
  console.log(APPLY ? 'Applied steps:' : 'Planned steps:')
  if (planned.length === 0) {
    console.log('- none')
  } else {
    for (const label of planned) {
      console.log(`- ${label}`)
    }
  }

  if (APPLY) {
    const after = await audit()
    printAudit('after', after)
  } else {
    console.log('')
    console.log('Dry run only. Re-run with --apply to execute the planned DDL.')
  }
} catch (error) {
  if (APPLY) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Ignore rollback errors; preserve the original failure.
    }
  }
  console.error(error.message)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}

function assertApplyIsExplicit() {
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--apply')
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(', ')}`)
  }
}

async function audit() {
  const tables = await queryRows(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name`,
    [['organization', 'box_template', 'box_template_region', 'snapshot', 'snapshot_region', 'warm_pool']],
  )
  const columns = await queryRows(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position`,
    [['organization', 'box_template', 'box_template_region', 'warm_pool']],
  )
  const enums = await queryRows(
    `SELECT t.typname, e.enumlabel
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     LEFT JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE n.nspname = 'public'
       AND t.typname = ANY($1)
     ORDER BY t.typname, e.enumsortorder`,
    [['box_template_state_enum']],
  )
  return {
    tables: tables.map((row) => row.table_name),
    columns,
    enums,
  }
}

function printAudit(label, snapshot) {
  console.log('')
  console.log(`Schema audit (${label})`)
  console.log(`- tables: ${snapshot.tables.join(', ') || 'none'}`)
  printColumns(snapshot.columns, 'organization')
  printColumns(snapshot.columns, 'box_template')
  printColumns(snapshot.columns, 'box_template_region')
  printColumns(snapshot.columns, 'warm_pool')
  const enumValues = snapshot.enums.map((row) => row.enumlabel).filter(Boolean)
  console.log(`- box_template_state_enum: ${enumValues.join(', ') || 'missing'}`)
}

function printColumns(columns, tableName) {
  const names = columns.filter((row) => row.table_name === tableName).map((row) => row.column_name)
  console.log(`- ${tableName} columns: ${names.join(', ') || 'missing'}`)
}

function legacyRename(table, from, to) {
  return {
    label: `rename ${table}.${from} -> ${to}`,
    needed: async () => (await columnExists(table, from)) && !(await columnExists(table, to)),
    sql: `ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`,
  }
}

function renameTable(from, to) {
  return {
    label: `rename table ${from} -> ${to}`,
    needed: async () => (await tableExists(from)) && !(await tableExists(to)),
    sql: `ALTER TABLE ${q(from)} RENAME TO ${q(to)}`,
  }
}

function addColumn(table, column, definition, legacyColumns = []) {
  return {
    label: `add ${table}.${column}`,
    needed: async () => {
      if (await columnExists(table, column)) return false
      for (const legacyColumn of legacyColumns) {
        if (await columnExists(table, legacyColumn)) return false
      }
      return await tableExists(table)
    },
    sql: `ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS ${q(column)} ${definition}`,
  }
}

function ensureUuidOssp() {
  return {
    label: 'ensure uuid-ossp extension',
    needed: async () => !(await extensionExists('uuid-ossp')),
    sql: 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
  }
}

function ensureEnum(name, values) {
  return {
    label: `create enum ${name}`,
    needed: async () => !(await enumExists(name)),
    sql: `CREATE TYPE ${q(name)} AS ENUM (${values.map((value) => quoteLiteral(value)).join(', ')})`,
  }
}

function ensureBoxTemplateTable() {
  return {
    label: 'create box_template table',
    needed: async () => !(await tableExists('box_template')) && !(await tableExists('snapshot')),
    sql: `CREATE TABLE IF NOT EXISTS "box_template" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "organizationId" uuid,
      "general" boolean NOT NULL DEFAULT false,
      "name" character varying NOT NULL,
      "imageName" character varying NOT NULL DEFAULT '',
      "artifactRef" character varying,
      "state" "public"."box_template_state_enum" NOT NULL DEFAULT 'pending',
      "errorReason" character varying,
      "size" double precision,
      "cpu" integer NOT NULL DEFAULT 1,
      "gpu" integer NOT NULL DEFAULT 0,
      "mem" integer NOT NULL DEFAULT 1,
      "disk" integer NOT NULL DEFAULT 3,
      "hideFromUsers" boolean NOT NULL DEFAULT false,
      "entrypoint" text array,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "lastUsedAt" TIMESTAMP,
      "buildInfoArtifactRef" character varying,
      "initialRunnerId" character varying,
      CONSTRAINT "box_template_id_pk" PRIMARY KEY ("id"),
      CONSTRAINT "box_template_organization_name_unique" UNIQUE ("organizationId", "name")
    )`,
  }
}

function ensureBoxTemplateRegionTable() {
  return {
    label: 'create box_template_region table',
    needed: async () => !(await tableExists('box_template_region')) && !(await tableExists('snapshot_region')),
    sql: `CREATE TABLE IF NOT EXISTS "box_template_region" (
      "templateId" uuid NOT NULL,
      "regionId" character varying NOT NULL,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "box_template_region_templateId_regionId_pk" PRIMARY KEY ("templateId", "regionId")
    )`,
  }
}

function addIndex(indexName, table, columns) {
  return {
    label: `create index ${indexName}`,
    needed: async () => (await tableExists(table)) && !(await indexExists(indexName)),
    sql: `CREATE INDEX IF NOT EXISTS ${q(indexName)} ON ${q(table)} (${columns.map(q).join(', ')})`,
  }
}

async function tableExists(table) {
  const { rowCount } = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [table],
  )
  return rowCount > 0
}

async function columnExists(table, column) {
  const { rowCount } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [table, column],
  )
  return rowCount > 0
}

async function extensionExists(name) {
  const { rowCount } = await client.query('SELECT 1 FROM pg_extension WHERE extname = $1', [name])
  return rowCount > 0
}

async function enumExists(name) {
  const { rowCount } = await client.query(
    `SELECT 1
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND t.typname = $1`,
    [name],
  )
  return rowCount > 0
}

async function indexExists(name) {
  const { rowCount } = await client.query(
    `SELECT 1
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = $1`,
    [name],
  )
  return rowCount > 0
}

async function queryRows(sql, params) {
  const result = await client.query(sql, params)
  return result.rows
}

function q(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}
