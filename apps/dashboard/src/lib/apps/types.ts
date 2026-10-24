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
  /** Memory it and its children use, while the Box runs. */
  memoryBytes?: number
  /** Its last error lines, when it is crashing, restarting or unhealthy. */
  recentErrors: string[]
}

/** Memory and disk of the whole Box the environment runs in (volumes live on its disk). */
export interface BoxUsage {
  memoryTotalBytes: number
  memoryAvailableBytes: number
  diskTotalBytes: number
  diskFreeBytes: number
}

export interface AppDomain {
  host: string
  env: string
  status: 'pending_dns' | 'active'
  /** The DNS records the owner adds at their DNS provider. */
  records: { type: 'TXT' | 'CNAME'; name: string; value: string }[]
  verified_at: string | null
}

export interface AppSchedule {
  name: string
  cron: string
  /** <service>:<path>, called as POST through the app proxy. */
  target: string
  /** null while nothing is live. */
  nextRun: string | null
  lastRun: string | null
  /** HTTP status of the last run. */
  lastStatus: number | null
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
  startedAt: string | null
  /** The step running now and since when, while the deployment is in progress. */
  running: { name: string; detail?: string; since: string | null } | null
  /** For a failed deployment: the classified cause, in a line. */
  cause: string | null
}

export interface TimelineStep {
  name: string
  status: ReleaseStep['status']
  ms: number | null
  detail: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface DeploymentLogLine {
  id: string
  ts: string
  source: string
  level: 'info' | 'warn' | 'error'
  line: string
}

/** shared/diagnose.ts: a failed deployment's classified cause and the fix. */
export interface DeploymentFailure {
  step: string
  message: string
  cause: string
  summary: string
  fix: string
  file?: string
  line?: number
  evidence: string[]
  /** Self-contained instructions for the agent. */
  fixPrompt: string
}

/** GET /apps/:id/deployments/:n: one deployment as a traceable timeline. */
export interface DeploymentDetail extends AppRelease {
  message: string | null
  specVersion: number | null
  baseVersion: number | null
  snapshotId: string | null
  rollbackTo: number | null
  timeline: TimelineStep[]
  log: DeploymentLogLine[]
  logTruncated: boolean
  changeSet: {
    infrastructure: string[]
    configuration: string[]
    code: { added: number; changed: number; removed: number; files: number; comparedWith: number | null } | null
  }
  failure: DeploymentFailure | null
}

/** Where an Activity row's object lives in the console. */
export interface ActivityLink {
  tab: AppTab
  section?: string
  deployment?: number
}

export interface AppActivity {
  id: string
  at: string
  /** key …2pjx, console, admin or system. */
  actor: string
  actorKind: 'agent' | 'console' | 'admin' | 'system'
  action: string
  detail?: string
  link?: ActivityLink
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
  /** How far back a restore can reach (the database's history window). */
  restoreWindowHours?: number
  errors?: string[]
}

export interface QueryResult {
  columns: string[]
  /** Postgres data type per column (table browsing only). */
  types?: (string | null)[]
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
  /** The failed deployment this is about. */
  deployment?: number
  /** What still serves users, when something does (#2). */
  serving?: string
  /** The variable a crashing service says it lacks; the console offers "Set NAME". */
  missingVariable?: string
}

export type AppTab = 'overview' | 'deployments' | 'logs' | 'domains' | 'auth' | 'database' | 'volumes' | 'variables'

export interface AppSignInMethod {
  provider: string
  /** How people know it: GitHub, Microsoft, X… */
  label: string
  /** ready: an OAuth app signs users in for it (the App's own, or BoxLite's); not_configured: none. */
  status: 'ready' | 'not_configured'
  /** This environment's [auth] lists it. */
  declared: boolean
  /** The platform-wide OAuth callback the provider's app lists. */
  redirectUri: string
  /** Whose OAuth app signs users in: BoxLite's (`shared`) or the App's own. */
  keys: 'shared' | 'own'
  /** The App's own OAuth client id (the secret is never sent to the console). */
  clientId: string | null
  /** BoxLite runs an OAuth app for this provider, so its keys can be used. */
  managedAvailable: boolean
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
  /** The App's SMTP sender for email code sign-in; absent from an older control plane. */
  emailSender?: EmailSender
}

export interface EmailSender {
  configured: boolean
  host: string | null
  port: number | null
  username: string | null
  from: string | null
  passwordSet: boolean
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
  /** Recent lines of the env's `auth` log source (sign-ins, refusals), newest first. */
  events: { id: string; ts: string; level: string; line: string }[]
}

/** 24 hourly buckets, oldest first, from the app proxy's access log and the env's sign-in sessions. */
export interface AppMetrics {
  requests: number[]
  errors: number[]
  /** null for an hour without requests. */
  p95Ms: (number | null)[]
  /** Distinct end users with a live session in each hour. */
  activeUsers: number[]
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
  /** The environment's own origin, from creation on. */
  url: string
  visibility: AppVisibility
  status: AppStatus
  lastDeploy: { releaseId: string; at: string; by: string } | null
  resources: { database: boolean; storage: number; users: number | null }
  createdAt: string
  /** How many environments the app has; the row itself shows main. */
  environments: number
  /** When main is failing: what is wrong, in a line, so the list can say it. */
  attention?: string
  /** While main deploys: "Deploying #4 · build". */
  progress?: string
  /** main's last screenshot (console API path), for the App list. */
  previewSrc?: string | null
  /** Other environments with a live deployment (main may have none yet). */
  liveIn?: string[]
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

/** The control plane's last screenshot of the live URL (taken when a deployment goes live). */
export interface AppPreview {
  /** Relative to the console API; read it through downloadUrl(). */
  src: string
  capturedAt: string
  releaseId: string
}

/** A new picture being taken, or why the last attempt failed (the picture shown stays the old one). */
export interface AppPreviewAttempt {
  taking: boolean
  failed: { at: string; reason: string } | null
}

export interface AppDetail extends Omit<AppSummary, 'environments'> {
  /** The control plane's own id of the App (app_…); `id` is its name. */
  appId: string
  /** Which environment this record describes. Everything below is scoped to it. */
  environment: string
  createdFrom: string | null
  runtime: { image: string; size: string; cpus: number | null; memoryMib: number | null } | null
  /** `usage` is read from the running Box: absent or null while it sleeps. */
  box: { id: string; state: string; usage?: BoxUsage | null } | null
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
  /** The deployment in progress, for the header's live line. */
  deploying: { id: string; number: number; step: string | null; detail: string | null; since: string } | null
  schedules: AppSchedule[]
  /** [variables] of the release serving now; differs from `variables` while a change deploys. */
  liveVariables: Record<string, string> | null
  /** null: no traffic in the last 48 hours and nobody signed in during the last 24. */
  metrics: AppMetrics | null
  preview: AppPreview | null
  previewAttempt: AppPreviewAttempt | null
  /** The handoff prompt with the App key masked; the full key is shown only once. */
  handoffPrompt: string
  key: { last4: string; createdAt: string } | null
  /** online: set in the console, wins over boxlite.toml. */
  accessSource: 'manifest' | 'online'
  specVersion: number | null
  auth: AppAuthStatus
  /** Custom domains of this environment; absent from an older control plane. */
  domains?: { supported: boolean; target: string | null; list: AppDomain[] }
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
  | { type: 'addSecret'; name: string; value: string }
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

/** A soft-deleted app, kept (and restorable) until purgeAfter. */
export interface DeletedApp {
  name: string
  deletedAt: string
  purgeAfter: string
  environments: number
}

export interface VolumeEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mode: string
  modified_at: string
}

export interface VolumeListing {
  volume: string
  path: string
  type: 'dir'
  entries: VolumeEntry[]
}

export interface ConsoleSession {
  /** Display name: the GitHub name or login, or `admin` for the platform operator. */
  user: string
  /** Signed in with the admin token: sees every organization. */
  admin: boolean
  profile?: { name: string | null; login: string | null; email: string | null; avatarUrl: string | null }
  /** The organization the console works in (null for the admin). */
  organization: {
    id: string
    name: string
    role: 'owner' | 'member'
    suspendedReason: string | null
    appLimit: number | null
    apps: number
  } | null
  controlPlane: string
  reservedNames: string[]
}
