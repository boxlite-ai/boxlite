/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Shapes of the Micro-cloud control plane's console API (/console/api, see
// boxlite-microcloud control-plane/src/console-views.ts). Everything here is
// built from real control-plane state; where the control plane has no data a
// field is null or empty and the screens hide it.

export type AppVisibility = 'private' | 'org' | 'public'

export type AppStatus = 'draft' | 'building' | 'live' | 'degraded' | 'sleeping' | 'failed'

/** The supervisor's words: running | starting | restarting | stopped | failed. */
export type ServiceState = string

/** healthy | unhealthy | starting | none */
export type ServiceHealth = string

export interface AppService {
  name: string
  command: string[]
  /** The one service end users reach (first with a port, or static). */
  exposed: boolean
  /** The PORT the supervisor gave it on this start. */
  port?: number
  healthPath?: string
  staticDir?: string
  state: ServiceState
  pid?: number
  restarts: number
  lastExitCode?: number
  health: ServiceHealth
}

/** Deployment statuses as the control plane reports them. */
export type ReleaseStatus =
  | 'queued'
  | 'uploading'
  | 'building'
  | 'migrating'
  | 'starting'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'rolled_back'

export const RELEASE_IN_PROGRESS: ReleaseStatus[] = ['queued', 'uploading', 'building', 'migrating', 'starting']

export interface ReleaseStep {
  name: string
  status: 'running' | 'done' | 'failed' | 'skipped'
  ms?: number
  detail?: string
}

export interface AppRelease {
  id: string
  number: number
  /** The agent's message, or what changed when it gave none. */
  summary: string
  createdAt: string
  finishedAt: string | null
  by: string
  status: ReleaseStatus
  /** The deployment serving now. */
  current: boolean
  error?: string
  steps: ReleaseStep[]
  /** The control plane's diff, one line each: "+ variables.LOG_LEVEL = info". */
  changes: string[]
  files: number | null
  bytes: number | null
  buildSeconds: number | null
  hasSource: boolean
  rollback: { possible: boolean; reason?: string }
  /** Set when this deployment ran migrations: the database state just before them. */
  restorePoint: string | null
}

export interface ReleaseLog {
  id: string
  status: ReleaseStatus
  steps: ReleaseStep[]
  log: string[]
}

export interface AppActivity {
  id: string
  at: string
  actor: string
  action: string
  detail?: string
}

export interface AppTable {
  schema: string
  name: string
  /** Live-row estimate from Postgres statistics; null when unknown. */
  rows: number | null
}

/** What the app page needs to name the database; the Database tab loads the rest. */
export interface AppDatabase {
  status: 'ready'
  engine: string
  host: string
  name: string
  user: string
  branch: string | null
  injectedAs: string
  injectedInto: string[]
}

export interface AppMigration {
  file: string
  status: 'applied' | 'pending' | 'changed'
  deployment?: number | null
  applied_at?: string
}

export interface AppBackup {
  id: string
  message: string | null
  ts: string
  by: string
}

/** GET /apps/:id/database: connection (never the password), tables, migrations, backups. */
export interface AppDatabaseDetail {
  status: 'ready' | 'unknown' | 'none'
  engine?: string
  host?: string
  name?: string
  user?: string
  branch?: string
  sizeBytes?: number | null
  tables?: AppTable[] | null
  migrations?: AppMigration[] | null
  backups?: AppBackup[] | null
  errors?: string[]
}

export interface QueryResult {
  columns: string[]
  rows: (string | number | boolean | null)[][]
  row_count?: number
  elapsed_ms?: number
  truncated?: boolean
  total?: number
}

export interface AppStorage {
  name: string
  mountPath: string
  mode: string
  /** The BoxLite managed volume behind it. */
  volumeName: string
  volumeId: string | null
  sizeBytes: number | null
  state: string | null
}

export interface AppSecretRef {
  name: string
  from: string
  inject: 'env'
  usedBy: string[]
  /** false when the org secret it names no longer exists. */
  present: boolean
}

export interface AppProblem {
  summary: string
  detail: string
  /** A prompt the user can hand to their agent. */
  fixPrompt?: string
}

export type AppTab = 'overview' | 'deployments' | 'logs' | 'auth' | 'database' | 'volumes' | 'variables'

export interface AppSignInMethod {
  provider: string
  /** ready: BoxLite's own OAuth app is set up on the control plane; not_configured: it is not. */
  status: 'ready' | 'not_configured'
  /** This environment's [auth] lists it. */
  declared: boolean
}

/** End-user sign-in of an environment, as the control plane reports it. */
export interface AppAuthStatus {
  /** [auth] is in the environment's configuration, so the app proxy signs visitors in. */
  declared: boolean
  providers: string[]
  protect: string[]
  /** Sign-in works: declared, and at least one of its providers is ready. */
  enforced: boolean
  methods: AppSignInMethod[]
  loginUrl: string
  users: number
  note: string | null
}

export interface AppEndUser {
  id: string
  email: string | null
  name: string | null
  provider: string
  firstSeen: string | null
  lastSeen: string | null
  sessions: number
  blocked: boolean
}

export interface AppAuthDetail {
  status: AppAuthStatus
  users: AppEndUser[]
}

/** 24 hourly buckets, oldest first, from the app proxy's access log. */
export interface AppMetrics {
  requests: number[]
  errors: number[]
  p95Ms: number[]
  /** Requests in the 24 hours before these, for a like-for-like comparison. */
  previousRequests?: number
}

export interface AppLogLine {
  id: string
  ts: string
  /** A service name, or build, schedule, auth, db, access, system. */
  source: string
  level: 'info' | 'warn' | 'error'
  line: string
  deployment: number | null
}

export interface AppSummary {
  id: string
  name: string
  slug: string
  /** <control plane>/<app>/, from creation on. */
  url: string
  /** Opens the app through the console, which signs the visitor in to a private app first. */
  openUrl: string
  visibility: AppVisibility
  status: AppStatus
  lastDeploy: { releaseId: string; at: string; by: string } | null
  resources: { database: boolean; storage: number; users: number | null }
  createdAt: string
  /** How many environments the app has; the row itself shows main. */
  environments: number
  /** When main is failing: what is wrong, in a line, so the list can say it. */
  attention?: string
}

/**
 * One environment of an app: its own Box, database branch, volumes and
 * variables. Every app starts with "main".
 */
export interface EnvironmentSummary {
  name: string
  status: AppStatus
  url: string
  box: string | null
  lastDeploy: { releaseId: string; at: string; by: string } | null
  /** The environment this one was branched from, if any. */
  from: string | null
}

/** Kept for the preview component; the control plane does not capture screenshots yet. */
export interface AppPreview {
  src: string
  capturedAt: string
  releaseId: string
}

export interface AppDetail extends Omit<AppSummary, 'environments'> {
  /** Which environment this record describes. Everything below is scoped to it. */
  environment: string
  createdFrom: string | null
  runtime: { image: string; size: string; cpus: number | null; memoryMib: number | null } | null
  box: { id: string; state: string } | null
  services: AppService[]
  activeRelease: string | null
  releases: AppRelease[]
  activity: AppActivity[]
  database: AppDatabase | null
  storages: AppStorage[]
  secrets: AppSecretRef[]
  /** [variables] of the latest configuration; null before the first apply or deploy. */
  variables: Record<string, string> | null
  /** Set by BoxLite at runtime; DATABASE_URL is shown without its password. */
  platformVariables: { name: string; value: string; kind: string }[]
  problems: AppProblem[]
  /** Why the environment is quiet or busy, in a line (asleep, deploying #4 · build). */
  statusDetail: string | null
  /** null: no traffic recorded in the last 48 hours. */
  metrics: AppMetrics | null
  /** The handoff prompt with the App key masked; the full key is shown only once. */
  handoffPrompt: string
  key: { last4: string; createdAt: string } | null
  /** online: set in the console, wins over boxlite.toml. */
  accessSource: 'manifest' | 'online'
  specVersion: number | null
  auth: AppAuthStatus
}

/**
 * Small operations behind the App screens' buttons (POST /apps/:id/actions?env=…).
 * Variable and secret changes each create one deployment.
 */
export type AppActionInput =
  | { type: 'setVariable'; name: string; value: string }
  | { type: 'removeVariable'; name: string }
  | { type: 'importVariables'; values: Record<string, string> }
  | { type: 'referenceSecret'; name: string; from: string }
  | { type: 'removeSecret'; name: string }
  | { type: 'createBackup'; message?: string }

/** Only a name: runtime, services and resources are the agent's to declare in boxlite.toml. */
export interface CreateAppInput {
  name: string
}

/** POST /apps: the key exists in clear text only in this response. */
export interface CreatedApp {
  app: AppDetail
  key: string
  prompt: string
}

export interface ConsoleSession {
  user: string
  controlPlane: string
  reservedNames: string[]
}
