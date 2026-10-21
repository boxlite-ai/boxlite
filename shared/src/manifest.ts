import { parse, TomlError } from 'smol-toml';
import {
  ACCESS_LEVELS,
  APP_NAME_RE,
  AUTH_PROVIDERS,
  HOSTNAME_RE,
  IMAGES,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  SECRET_REF_RE,
  SERVICE_NAME_RE,
  SIZES,
  VARIABLE_NAME_RE,
  type Access,
  type AuthProvider,
  type CheckError,
  type CheckWarning,
  type Image,
  type Manifest,
  type ServiceSpec,
  type Size,
} from './types.js';
import { validateCron } from './cron.js';

export interface ParseResult {
  manifest: Manifest | null;
  errors: CheckError[];
  warnings: CheckWarning[];
}

type Raw = Record<string, unknown>;
type Path = (string | number)[];

function isTable(v: unknown): v is Raw {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/** `[env.<name>]` overrides: tables merge key by key, arrays and scalars replace. */
export function mergeOverride(base: Raw, override: Raw): Raw {
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    out[k] = isTable(cur) && isTable(v) ? mergeOverride(cur, v) : v;
  }
  return out;
}

const HEADER_RE = /^\s*\[(\[)?\s*([^\]]+?)\s*\]\]?/;

function headerName(line: string): { name: string; array: boolean } | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  return { name: m[2]!.replace(/"/g, ''), array: m[1] === '[' };
}

function keyRe(key: string): RegExp {
  const escaped = key.split('.').map((s) => `"?${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`).join('\\.');
  return new RegExp(`^\\s*${escaped}\\s*=`);
}

/**
 * smol-toml gives no positions, so locate a path such as `['service', 1, 'port']` by scanning
 * the source for the right table header (the n-th `[[service]]`) and then the key inside it.
 * Returns the header line when the key itself is absent (e.g. a missing required field).
 */
export function lineOf(source: string, path: Path): number | undefined {
  const lines = source.split(/\r?\n/);
  const segs = path.map(String);
  const wantIndex = typeof path[path.length - 2] === 'number' ? (path[path.length - 2] as number) : undefined;

  if (path.length === 1) {
    const re = keyRe(segs[0]!);
    const idx = lines.findIndex((l) => re.test(l) || headerName(l)?.name === segs[0]);
    return idx >= 0 ? idx + 1 : undefined;
  }

  const nameSegs = segs.filter((_, i) => typeof path[i] !== 'number');
  const lastIsKey = typeof path[path.length - 1] !== 'number';
  const tableSegs = lastIsKey ? nameSegs.slice(0, -1) : nameSegs;
  const key = lastIsKey ? nameSegs[nameSegs.length - 1]! : undefined;

  for (let k = tableSegs.length; k >= 1; k--) {
    const header = tableSegs.slice(0, k).join('.');
    const rest = tableSegs.slice(k);
    const arrayIndex = typeof path[k] === 'number' ? (path[k] as number) : wantIndex;
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
      const h = headerName(lines[i]!);
      if (!h || h.name !== header) continue;
      if (h.array && arrayIndex !== undefined && ++seen !== arrayIndex) continue;
      if (key === undefined) return i + 1;
      const re = keyRe([...rest, key].join('.'));
      for (let j = i + 1; j < lines.length; j++) {
        if (headerName(lines[j]!)) break;
        if (re.test(lines[j]!)) return j + 1;
      }
      return i + 1;
    }
  }
  if (key !== undefined) {
    // Dotted top-level key such as `runtime.size = "small"`.
    const re = keyRe([...tableSegs, key].join('.'));
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) return idx + 1;
  }
  return undefined;
}

class Validator {
  readonly errors: CheckError[] = [];
  readonly warnings: CheckWarning[] = [];

  constructor(private readonly source: string, private readonly env: string) {}

  error(path: Path, rule: string, message: string): void {
    const line = lineOf(this.source, path) ?? lineOf(this.source, ['env', this.env, ...path]);
    const err: CheckError = { file: MANIFEST_FILE, rule, message };
    if (line !== undefined) err.line = line;
    this.errors.push(err);
  }

  warn(rule: string, message: string): void {
    this.warnings.push({ rule, message });
  }

  unknownKeys(table: Raw, allowed: readonly string[], path: Path): void {
    for (const k of Object.keys(table)) {
      if (!allowed.includes(k)) this.error([...path, k], 'unknown_field', `unknown field "${[...path.filter((p) => typeof p === 'string'), k].join('.')}"`);
    }
  }

  table(v: unknown, path: Path): Raw | undefined {
    if (v === undefined) return undefined;
    if (!isTable(v)) {
      this.error(path, 'invalid_type', `${fmt(path)} must be a table`);
      return undefined;
    }
    return v;
  }

  string(v: unknown, path: Path, opts: { required?: boolean } = {}): string | undefined {
    if (v === undefined) {
      if (opts.required) this.error(path, 'missing_field', `${fmt(path)} is required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      this.error(path, 'invalid_type', `${fmt(path)} must be a string`);
      return undefined;
    }
    return v;
  }

  stringArray(v: unknown, path: Path): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      this.error(path, 'invalid_type', `${fmt(path)} must be an array of strings`);
      return undefined;
    }
    return v as string[];
  }

  tableArray(v: unknown, path: Path): Raw[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(isTable)) {
      this.error(path, 'invalid_type', `${fmt(path)} must be an array of tables ([[${path[0]}]])`);
      return [];
    }
    return v as Raw[];
  }

  oneOf<T extends string>(v: unknown, path: Path, allowed: readonly T[], rule: string, fallback: T): T {
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      this.error(path, rule, `${fmt(path)} must be one of ${allowed.join(', ')}`);
      return fallback;
    }
    return v as T;
  }
}

function fmt(path: Path): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');
}

/** Parses boxlite.toml, applies `[env.<env>]` overrides and validates the rules of contracts §0. */
export function parseManifest(toml: string, env = 'main'): ParseResult {
  let raw: Raw;
  try {
    raw = parse(toml) as Raw;
  } catch (e) {
    const err: CheckError = { file: MANIFEST_FILE, rule: 'toml_syntax', message: String((e as Error).message).split('\n')[0] ?? 'invalid TOML' };
    if (e instanceof TomlError) err.line = e.line;
    return { manifest: null, errors: [err], warnings: [] };
  }

  const v = new Validator(toml, env);
  v.unknownKeys(raw, MANIFEST_SCHEMA.top, []);

  const envs = v.table(raw.env, ['env']) ?? {};
  for (const [name, table] of Object.entries(envs)) {
    const t = v.table(table, ['env', name]);
    if (t) v.unknownKeys(t, MANIFEST_SCHEMA.envOverride, ['env', name]);
  }
  const { env: _ignored, ...base } = raw;
  const override = envs[env];
  const merged = isTable(override) ? mergeOverride(base, override) : base;

  const name = appName(v, merged);

  const rt = v.table(merged.runtime, ['runtime']);
  if (merged.runtime === undefined) v.error(['runtime'], 'missing_field', '[runtime] is required');
  if (rt) v.unknownKeys(rt, MANIFEST_SCHEMA.runtime, ['runtime']);
  if (rt && rt.image === undefined) v.error(['runtime'], 'missing_field', 'runtime.image is required');
  const image = v.oneOf<Image>(rt?.image, ['runtime', 'image'], IMAGES, 'invalid_image', 'base');
  const size = v.oneOf<Size>(rt?.size, ['runtime', 'size'], Object.keys(SIZES) as Size[], 'invalid_size', 'small');
  const build = v.stringArray(rt?.build, ['runtime', 'build']) ?? [];
  const output = v.string(rt?.output, ['runtime', 'output']) ?? null;

  const services: ServiceSpec[] = [];
  const serviceNames = new Set<string>();
  const rawServices = v.tableArray(merged.service, ['service']);
  rawServices.forEach((s, i) => {
    const p: Path = ['service', i];
    v.unknownKeys(s, MANIFEST_SCHEMA.service, p);
    const sname = v.string(s.name, [...p, 'name'], { required: true }) ?? `service-${i}`;
    if (s.name !== undefined && !SERVICE_NAME_RE.test(sname)) v.error([...p, 'name'], 'invalid_name', `service name "${sname}" must match ${SERVICE_NAME_RE}`);
    if (serviceNames.has(sname)) v.error([...p, 'name'], 'duplicate_service', `service "${sname}" is defined twice`);
    serviceNames.add(sname);
    const svc: ServiceSpec = { name: sname };
    const command = v.string(s.command, [...p, 'command']);
    const stat = v.string(s.static, [...p, 'static']);
    if (s.port !== undefined) {
      if (typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
        v.error([...p, 'port'], 'invalid_port', `service "${sname}": port must be an integer between 1 and 65535`);
      } else {
        svc.port = s.port;
      }
    }
    if (stat !== undefined) {
      if (stat === '' || stat.startsWith('/') || stat.split('/').includes('..')) {
        v.error([...p, 'static'], 'invalid_path', `service "${sname}": static must be a relative path inside the project`);
      } else {
        svc.static = stat;
      }
      if (command !== undefined) v.error([...p, 'command'], 'static_with_command', `service "${sname}": static services cannot have a command`);
      if (svc.port !== undefined) v.warn('port_ignored', `service "${sname}": port is ignored for static services`);
    } else {
      if (command === undefined) v.error([...p, 'command'], 'missing_field', `service "${sname}": command is required (or set static = "dir/")`);
      else svc.command = command;
    }
    const health = v.string(s.health, [...p, 'health']);
    if (health !== undefined) {
      if (!health.startsWith('/')) v.error([...p, 'health'], 'invalid_health', `service "${sname}": health must be a path starting with /`);
      else svc.health = health;
    }
    services.push(svc);
  });
  if (rawServices.length === 0) v.error(['service'], 'missing_field', 'at least one [[service]] is required');

  const exposed = services.filter((s) => s.port !== undefined || s.static !== undefined);
  if (services.length > 0 && exposed.length === 0) {
    v.error(['service', 0], 'no_exposed_service', 'exactly one service must be exposed: set port = <int> or static = "dir/" on it');
  }
  if (exposed.length > 1) {
    const idx = services.indexOf(exposed[1]!);
    v.error(['service', idx], 'multiple_exposed_services', `only one service may be exposed; ${exposed.map((s) => `"${s.name}"`).join(' and ')} both set port/static`);
  }
  const exposedService = exposed[0];
  for (const s of services) {
    if (s === exposedService && s.command !== undefined && s.health === undefined) s.health = '/';
    if (s !== exposedService && s.health !== undefined) v.warn('health_ignored', `service "${s.name}": health is only checked on the exposed service`);
  }

  const schedules = v.tableArray(merged.schedule, ['schedule']).map((s, i) => {
    const p: Path = ['schedule', i];
    v.unknownKeys(s, MANIFEST_SCHEMA.schedule, p);
    const sname = v.string(s.name, [...p, 'name'], { required: true }) ?? `schedule-${i}`;
    if (s.name !== undefined && !SERVICE_NAME_RE.test(sname)) v.error([...p, 'name'], 'invalid_name', `schedule name "${sname}" must match ${SERVICE_NAME_RE}`);
    const cron = v.string(s.cron, [...p, 'cron'], { required: true }) ?? '';
    if (cron) {
      const problem = validateCron(cron);
      if (problem) v.error([...p, 'cron'], 'invalid_cron', `schedule "${sname}": ${problem}`);
    }
    const target = v.string(s.target, [...p, 'target'], { required: true }) ?? '';
    if (target) {
      const m = /^([a-z][a-z0-9-]*):(\/.*)$/.exec(target);
      if (!m) v.error([...p, 'target'], 'invalid_schedule_target', `schedule "${sname}": target must be "<service>:/path"`);
      else if (!serviceNames.has(m[1]!)) v.error([...p, 'target'], 'invalid_schedule_target', `schedule "${sname}": unknown service "${m[1]}"`);
      else if (exposedService && m[1] !== exposedService.name) v.error([...p, 'target'], 'invalid_schedule_target', `schedule "${sname}": target service "${m[1]}" is not the exposed service`);
    }
    return { name: sname, cron, target };
  });

  let database: Manifest['database'] = null;
  const db = v.table(merged.database, ['database']);
  if (db) {
    v.unknownKeys(db, MANIFEST_SCHEMA.database, ['database']);
    const migrations = v.string(db.migrations, ['database', 'migrations']) ?? 'migrations/';
    if (migrations.startsWith('/') || migrations.split('/').includes('..')) v.error(['database', 'migrations'], 'invalid_path', 'database.migrations must be a relative path inside the project');
    database = { migrations: migrations.endsWith('/') ? migrations : `${migrations}/` };
  }

  const volumeNames = new Set<string>();
  const volumes = v.tableArray(merged.volume, ['volume']).map((vol, i) => {
    const p: Path = ['volume', i];
    v.unknownKeys(vol, MANIFEST_SCHEMA.volume, p);
    const vname = v.string(vol.name, [...p, 'name'], { required: true }) ?? `volume-${i}`;
    if (vol.name !== undefined && !SERVICE_NAME_RE.test(vname)) v.error([...p, 'name'], 'invalid_name', `volume name "${vname}" must match ${SERVICE_NAME_RE}`);
    if (volumeNames.has(vname)) v.error([...p, 'name'], 'duplicate_volume', `volume "${vname}" is defined twice`);
    volumeNames.add(vname);
    const mount = v.string(vol.mount, [...p, 'mount'], { required: true }) ?? '';
    if (mount && !mount.startsWith('/')) v.error([...p, 'mount'], 'invalid_path', `volume "${vname}": mount must be an absolute path`);
    const mode = v.oneOf(vol.mode, [...p, 'mode'], ['rw', 'ro'] as const, 'invalid_volume_mode', 'rw');
    return { name: vname, mount, mode, from: v.string(vol.from, [...p, 'from']) ?? null, path: v.string(vol.path, [...p, 'path']) ?? null };
  });

  let auth: Manifest['auth'] = null;
  const authT = v.table(merged.auth, ['auth']);
  if (authT) {
    v.unknownKeys(authT, MANIFEST_SCHEMA.auth, ['auth']);
    const providers = v.stringArray(authT.providers, ['auth', 'providers']) ?? [];
    if (authT.providers === undefined || providers.length === 0) v.error(['auth', 'providers'], 'invalid_auth', 'auth.providers must list at least one of google, github');
    for (const prov of providers) {
      if (!(AUTH_PROVIDERS as readonly string[]).includes(prov)) v.error(['auth', 'providers'], 'invalid_auth', `unknown auth provider "${prov}" (google, github)`);
    }
    const protect = v.stringArray(authT.protect, ['auth', 'protect']) ?? [];
    for (const pat of protect) {
      if (!pat.startsWith('/')) v.error(['auth', 'protect'], 'invalid_path', `auth.protect entries must start with / (got "${pat}")`);
    }
    auth = { providers: providers.filter((p): p is AuthProvider => (AUTH_PROVIDERS as readonly string[]).includes(p)), protect };
  }

  const domainsT = v.table(merged.domains, ['domains']);
  const custom = domainsT ? (v.unknownKeys(domainsT, MANIFEST_SCHEMA.domains, ['domains']), v.stringArray(domainsT.custom, ['domains', 'custom']) ?? []) : [];
  for (const d of custom) {
    if (!HOSTNAME_RE.test(d)) v.error(['domains', 'custom'], 'invalid_domain', `"${d}" is not a valid hostname`);
  }

  const access = v.oneOf<Access>(merged.access, ['access'], ACCESS_LEVELS, 'invalid_access', 'private');

  const variables = stringMap(v, merged.variables, 'variables', (k) => (VARIABLE_NAME_RE.test(k) ? null : `variable "${k}" must match ${VARIABLE_NAME_RE}`), 'invalid_variable');
  const secrets = stringMap(v, merged.secrets, 'secrets', (k, val) => {
    if (!VARIABLE_NAME_RE.test(k)) return `secret "${k}" must match ${VARIABLE_NAME_RE}`;
    if (!SECRET_REF_RE.test(val)) return `secret "${k}" must reference "org/path" (got "${val}")`;
    return null;
  }, 'invalid_secret_ref');
  for (const k of Object.keys(secrets)) {
    if (k in variables) v.error(['secrets', k], 'duplicate_variable', `"${k}" is both a variable and a secret`);
  }

  const manifest: Manifest = {
    app: name,
    environment: env,
    runtime: { image, size, build, output },
    services,
    schedules,
    database,
    volumes,
    auth,
    domains: { builtin: name, custom },
    access,
    variables,
    secrets,
  };
  return { manifest: v.errors.length === 0 ? manifest : null, errors: v.errors, warnings: v.warnings };
}

/**
 * The App name: `[app] name = "crm"` (canonical, what `init` writes) or a top-level `name = "crm"`.
 * Both forms may appear only when they agree.
 */
function appName(v: Validator, merged: Raw): string {
  const appT = v.table(merged.app, ['app']);
  if (appT) v.unknownKeys(appT, MANIFEST_SCHEMA.app, ['app']);
  const inTable = v.string(appT?.name, ['app', 'name']);
  const topLevel = v.string(merged.name, ['name']);
  if (inTable !== undefined && topLevel !== undefined && inTable !== topLevel) {
    v.error(['name'], 'conflicting_name', `name "${topLevel}" and [app] name "${inTable}" differ; keep only [app] name`);
  }
  const name = inTable ?? topLevel;
  const path: Path = inTable !== undefined ? ['app', 'name'] : ['name'];
  if (name === undefined) {
    if (merged.app === undefined && merged.name === undefined) v.error(['app'], 'missing_field', '[app] name is required');
    else if (appT && appT.name === undefined && topLevel === undefined) v.error(['app', 'name'], 'missing_field', 'app.name is required');
    return '';
  }
  if (!APP_NAME_RE.test(name)) v.error(path, 'invalid_name', `name "${name}" must match ${APP_NAME_RE}`);
  return name;
}

function stringMap(v: Validator, raw: unknown, key: string, check: (k: string, val: string) => string | null, rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = v.table(raw, [key]);
  if (!t) return out;
  for (const [k, val] of Object.entries(t)) {
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      v.error([key, k], 'invalid_type', `${key}.${k} must be a string`);
      continue;
    }
    const s = String(val);
    const problem = check(k, s);
    if (problem) v.error([key, k], rule, problem);
    else out[k] = s;
  }
  return out;
}

/** The `[[service]]` that receives end-user traffic (first with `port` or `static`). */
export function exposedService(manifest: Manifest): ServiceSpec | undefined {
  return manifest.services.find((s) => s.port !== undefined || s.static !== undefined);
}
