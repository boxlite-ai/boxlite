export type Image = 'base' | 'python' | 'node';
export type Size = 'nano' | 'small' | 'medium' | 'large';
export type Access = 'private' | 'org' | 'public';
/** OAuth providers, and `email`: a code mailed through the App's own SMTP sender (docs/email-sign-in.md). */
export type AuthProvider = 'google' | 'github' | 'microsoft' | 'apple' | 'x' | 'facebook' | 'email';
export type VolumeMode = 'rw' | 'ro';

export const IMAGES: readonly Image[] = ['base', 'python', 'node'];
export const SIZES: Record<Size, { cpus: number; memory_mib: number }> = {
  nano: { cpus: 1, memory_mib: 1024 },
  small: { cpus: 1, memory_mib: 2048 },
  medium: { cpus: 2, memory_mib: 4096 },
  large: { cpus: 4, memory_mib: 8192 },
};
export const ACCESS_LEVELS: readonly Access[] = ['private', 'org', 'public'];
export const AUTH_PROVIDERS: readonly AuthProvider[] = ['google', 'github', 'microsoft', 'apple', 'x', 'facebook', 'email'];

export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const VARIABLE_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const SECRET_REF_RE = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_./-]+$/;
export const MIGRATION_FILE_RE = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export interface RuntimeSpec {
  image: Image;
  size: Size;
  build: string[];
  output: string | null;
}

export interface ServiceSpec {
  name: string;
  command?: string;
  /** Port hint from boxlite.toml. Presence marks the service as exposed; the supervisor assigns the real PORT. */
  port?: number;
  health?: string;
  static?: string;
}

export interface ScheduleSpec {
  name: string;
  cron: string;
  target: string;
}

export interface DatabaseSpec {
  migrations: string;
}

export interface VolumeSpec {
  name: string;
  mount: string;
  mode: VolumeMode;
  from: string | null;
  path: string | null;
}

export interface AuthSpec {
  providers: AuthProvider[];
  protect: string[];
}

export interface DomainsSpec {
  builtin: string;
  custom: string[];
}

/** Spec JSON of contracts §0 minus the platform-assigned parts (`assigned`, `version`, `deployment`, `base_version`, `database.applied`). */
export interface Manifest {
  app: string;
  environment: string;
  runtime: RuntimeSpec;
  services: ServiceSpec[];
  schedules: ScheduleSpec[];
  database: DatabaseSpec | null;
  volumes: VolumeSpec[];
  auth: AuthSpec | null;
  domains: DomainsSpec;
  access: Access;
  /** Paths anyone may reach even when `access` is private or org, e.g. a payment provider's webhook. */
  public_paths: string[];
  variables: Record<string, string>;
  secrets: Record<string, string>;
}

/** Keys accepted at each level of boxlite.toml. Anything else is an `unknown_field` error. */
export const MANIFEST_SCHEMA = {
  top: ['app', 'name', 'runtime', 'service', 'schedule', 'database', 'volume', 'auth', 'domains', 'access', 'public_paths', 'variables', 'secrets', 'env'],
  envOverride: ['runtime', 'service', 'schedule', 'database', 'volume', 'auth', 'domains', 'access', 'public_paths', 'variables', 'secrets'],
  app: ['name'],
  runtime: ['image', 'size', 'build', 'output'],
  service: ['name', 'command', 'port', 'health', 'static'],
  schedule: ['name', 'cron', 'target'],
  database: ['migrations'],
  volume: ['name', 'mount', 'mode', 'from', 'path'],
  auth: ['providers', 'protect'],
  domains: ['custom'],
} as const;

export interface CheckError {
  file: string;
  line?: number;
  rule: string;
  message: string;
}

export interface CheckWarning {
  rule: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  errors: CheckError[];
  warnings: CheckWarning[];
}

export interface UploadFile {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}

export interface UploadManifest {
  files: UploadFile[];
  bytes: number;
  /** Excluded files whose name looks like a secret (`.env*`, `*.pem`, `id_rsa*`, `*.key`), reported so `plan` can mention them. */
  excludedSecrets: string[];
  /** Symlinks and special files that were skipped. */
  skipped: string[];
}

export const MANIFEST_FILE = 'boxlite.toml';
export const UPLOAD_WARN_BYTES = 50 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
