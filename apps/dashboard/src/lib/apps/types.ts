/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Shapes for the App resource as the console mock understands it. The real
// contract is still being designed (product_design/PRD/AgentCloud/FullStack);
// these types track the 02 design note and exist so the mock pages have one
// source of truth to render from.

export type AppVisibility = 'private' | 'org' | 'users' | 'public'

export type AppStatus = 'draft' | 'building' | 'live' | 'degraded' | 'sleeping' | 'failed' | 'rebuilding'

export type ServiceState = 'running' | 'starting' | 'restarting' | 'stopped' | 'failed'

export type ServiceHealth = 'healthy' | 'unhealthy' | 'starting' | 'none'

export interface AppService {
  name: string
  command: string[]
  port?: number
  healthPath?: string
  restart: 'no' | 'on-failure' | 'always'
  state: ServiceState
  pid?: number
  restarts: number
  lastExitCode?: number
  health: ServiceHealth
}

export type ReleaseStatus = 'uploading' | 'preparing' | 'activating' | 'active' | 'previous' | 'failed'

export interface AppRelease {
  id: string
  /** What changed, in a line, as the agent described it when it deployed. */
  summary?: string
  createdAt: string
  by: string
  files: number
  bytes: number
  prepareSeconds?: number
  status: ReleaseStatus
  error?: string
  log: string[]
  /** For a deployment that only applied variable changes: what it changed, so it can be reverted. */
  envChanges?: PendingChange[]
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
  rows: number
}

export interface AppDatabase {
  status: 'ready' | 'provisioning' | 'error'
  engine: string
  region: string
  sizeBytes: number
  host: string
  name: string
  user: string
  injectedAs: string
  injectedInto: string[]
  tables: AppTable[]
  migrations: { file: string; appliedIn: string; at: string }[]
  backups: { at: string; bytes: number; manual?: boolean }[]
}

export interface AppStorage {
  name: string
  public: boolean
  sizeBytes: number
  objects: number
  envPrefix: string
  mountPath?: string
  publicUrlBase?: string
  keys: { id: string; createdAt: string; lastUsedAt?: string }[]
}

export interface AppUser {
  email: string
  provider: string
  firstSeen: string
  lastSeen: string
  sessions: number
  blocked?: boolean
}

/**
 * Small operations behind the App screens' buttons, one endpoint in the mock
 * (POST /apps/:id/actions?env=…). Each is scoped to one environment.
 */
export type AppActionInput =
  | { type: 'setVariable'; name: string; value: string }
  | { type: 'removeVariable'; name: string }
  | { type: 'importVariables'; values: Record<string, string> }
  | { type: 'referenceSecret'; name: string; from: string; inject: 'env' | 'placeholder'; hosts?: string[] }
  | { type: 'createBackup' }
  | { type: 'attachDatabase' }
  | { type: 'rotateDatabasePassword' }
  | { type: 'signOutUser'; email: string }
  | { type: 'blockUser'; email: string; blocked: boolean }
  | { type: 'rotateVolumeKey'; bucket: string }
  | { type: 'setVolumePublic'; bucket: string; public: boolean }
  | { type: 'deployChanges' }

export type AuthProvider = 'google' | 'github' | 'microsoft' | 'apple' | 'email'

export interface AuthEvent {
  at: string
  kind: 'login' | 'callback_mismatch' | 'blocked' | 'signup'
  provider: AuthProvider
  email?: string
  detail: string
}

/**
 * One way to sign in. OAuth providers run on BoxLite's shared OAuth app
 * ("shared": visitors see BoxLite on the consent screen) or the customer's own
 * ("own"). A custom provider is any OIDC issuer, found by its discovery URL.
 */
export interface AuthMethod {
  provider: AuthProvider | 'custom'
  keys: 'shared' | 'own'
  clientId?: string
  /** custom only */
  key?: string
  name?: string
  discoveryUrl?: string
}

export interface AppSmtp {
  senderEmail: string
  senderName: string
  host: string
  port: number
  username: string
}

export interface AppAuth {
  methods: AuthMethod[]
  sessionTtl: string
  loginUrl: string
  /** Base callback URL; each provider appends /<provider> (custom: /custom/<key>). */
  callbackUrl: string
  allowedEmails: string[]
  allowSignups: boolean
  requireVerifiedEmail: boolean
  /** null = codes are sent from noreply@boxlite.app */
  smtp: AppSmtp | null
  users: AppUser[]
  events: AuthEvent[]
}

export interface UpdateAuthInput {
  upsertMethod?: AuthMethod
  /** methodId() of the method to remove */
  removeMethod?: string
  allowedEmails?: string[]
  sessionTtl?: string
  allowSignups?: boolean
  requireVerifiedEmail?: boolean
  smtp?: AppSmtp | null
}

export function methodId(method: Pick<AuthMethod, 'provider' | 'key'>): string {
  return method.provider === 'custom' ? `custom:${method.key}` : method.provider
}

export interface AppSecretRef {
  name: string
  from: string
  version: number
  inject: 'env' | 'placeholder'
  hosts?: string[]
  usedBy: string[]
}

export interface AppCustomDomain {
  domain: string
  status: 'verified' | 'pending' | 'invalid'
  tls: 'issued' | 'pending' | 'none'
  cname: string
  addedAt: string
  lastCheckedAt?: string
  lastCheck?: string
}

export interface AppDomains {
  slug: string
  /** The built-in <slug>.boxlite.app address every app has from creation. */
  defaultDomain: string
  /** Domains the customer brings; optional. */
  custom: AppCustomDomain[]
  /** The custom domain the app is presented under (Visit, Overview, the Apps list); null = the built-in one. */
  primary: string | null
}

export interface AppPort {
  port: number
  visibility: AppVisibility
  url: string
  service?: string
}

export interface AppWorkspace {
  boxId: string
  boxName: string
  boxState: 'running' | 'stopped' | 'starting' | 'error'
  image: string
  cpu: number
  memory: number
  disk: number
  region: string
  ports: AppPort[]
  env: Record<string, string>
}

export interface ReachabilityCheck {
  ok: boolean
  summary: string
  detail: string
  /** A prompt the user can hand to their agent to fix a failing check. */
  fixPrompt?: string
}

export interface AppReachability {
  published: ReachabilityCheck
  listening: ReachabilityCheck
  routed: ReachabilityCheck
}

export type AppTab = 'overview' | 'deployments' | 'logs' | 'domains' | 'auth' | 'database' | 'volumes' | 'variables'

/** 24 hourly buckets, oldest first. Empty arrays mean no traffic yet. */
export interface AppMetrics {
  requests: number[]
  errors: number[]
  p95Ms: number[]
  activeUsers: number[]
  /** Requests in the 24 hours before these, for a like-for-like comparison. */
  previousRequests?: number
}

export type AppLogSource = 'web' | 'worker' | 'deploy' | 'auth' | 'db' | 'system'

export interface AppSummary {
  id: string
  name: string
  slug: string
  url: string | null
  visibility: AppVisibility
  status: AppStatus
  lastDeploy: { releaseId: string; at: string; by: string } | null
  resources: { database: boolean; storage: number; users: number | null }
  createdAt: string
  /** How many environments the app has; the row itself shows production. */
  environments: number
  /** When production is failing: what is wrong, in a line, so the list can say it. */
  attention?: string
}

/**
 * One environment of an app: its own box, database, user pool, volumes,
 * domains and variables. Deployments are made to an environment; data stays
 * in it across deployments. Every app starts with "production".
 */
export interface EnvironmentSummary {
  name: string
  status: AppStatus
  url: string | null
  box: string
  lastDeploy: { releaseId: string; at: string; by: string } | null
  /** The environment this one was created from, if any. */
  from: string | null
}

/** What the live URL showed when the proxy last captured it, after a release went live. */
export interface AppPreview {
  src: string
  capturedAt: string
  releaseId: string
}

export interface AppDetail extends Omit<AppSummary, 'environments'> {
  /** Which environment this record describes. Everything below is scoped to it. */
  environment: string
  /** The environment this one was created from; production has none. */
  createdFrom?: string | null
  image: string
  region: string
  services: AppService[]
  activeRelease: string | null
  preview: AppPreview | null
  releases: AppRelease[]
  activity: AppActivity[]
  database: AppDatabase | null
  storages: AppStorage[]
  auth: AppAuth
  secrets: AppSecretRef[]
  domains: AppDomains
  workspace: AppWorkspace
  reachability: AppReachability
  metrics: AppMetrics
  logs: Partial<Record<AppLogSource, string[]>>
  handoffPrompt: string
  /**
   * How the saved variables differ from the ones the running deployment uses. Net: setting a value back to its
   * live one removes the entry. They reach the app on the next deployment.
   */
  pendingChanges?: PendingChange[]
}

export interface PendingChange {
  name: string
  change: 'added' | 'changed' | 'removed'
  /** The value the running deployment uses; secrets are described, never shown. */
  live?: string
  secret?: boolean
}

export const describeChange = (c: PendingChange) => `${c.name} ${c.change}`

/** Only a name: runtime, services and resources are the agent's to declare in boxlite.toml. */
export interface CreateAppInput {
  name: string
}
