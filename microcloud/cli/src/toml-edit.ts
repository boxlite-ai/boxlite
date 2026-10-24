import { parse, stringify } from 'smol-toml';

export type TomlDoc = Record<string, unknown>;

export interface TomlEdit {
  text: string;
  /** True when the source had comments; `stringify` cannot preserve them. */
  droppedComments: boolean;
}

/** Parse → mutate → stringify. Comments are lost, which callers must mention once. */
export function editToml(source: string, mutate: (doc: TomlDoc) => void): TomlEdit {
  const doc = parse(source) as TomlDoc;
  mutate(doc);
  return { text: stringify(doc), droppedComments: /^\s*#|\s#\s/m.test(source) };
}

/** Returns the nested table at `path`, creating intermediate tables. */
export function ensureTable(doc: TomlDoc, path: string[]): TomlDoc {
  let cur = doc;
  for (const key of path) {
    const next = cur[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as TomlDoc;
  }
  return cur;
}

function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * Writes a Spec (as returned by `GET …/spec`) back as boxlite.toml. Platform-assigned fields
 * (`assigned`, `version`, `deployment`, `base_version`, `database.applied`, `domains.builtin`) are dropped.
 */
export function specToToml(spec: Record<string, unknown>): string {
  const runtime = (spec.runtime ?? {}) as Record<string, unknown>;
  const doc: TomlDoc = {
    access: spec.access ?? 'private',
    app: { name: spec.app ?? spec.name },
    runtime: compact({ image: runtime.image, size: runtime.size, build: runtime.build ?? [], output: runtime.output }),
  };
  const services = (spec.services as Record<string, unknown>[] | undefined) ?? [];
  if (services.length) doc.service = services.map((s) => compact({ name: s.name, command: s.command, port: s.port === true ? 3000 : s.port, health: s.health, static: s.static }));
  const schedules = (spec.schedules as Record<string, unknown>[] | undefined) ?? [];
  if (schedules.length) doc.schedule = schedules.map((s) => compact({ name: s.name, cron: s.cron, target: s.target }));
  const database = spec.database as Record<string, unknown> | null | undefined;
  if (database) doc.database = compact({ migrations: database.migrations ?? 'migrations/' });
  const volumes = (spec.volumes as Record<string, unknown>[] | undefined) ?? [];
  if (volumes.length) doc.volume = volumes.map((v) => compact({ name: v.name, mount: v.mount, mode: v.mode, from: v.from, path: v.path }));
  const auth = spec.auth as Record<string, unknown> | null | undefined;
  if (auth) doc.auth = compact({ providers: auth.providers, protect: auth.protect });
  const domains = spec.domains as Record<string, unknown> | undefined;
  const custom = (domains?.custom as string[] | undefined) ?? [];
  if (custom.length) doc.domains = { custom };
  const publicPaths = (spec.public_paths as string[] | undefined) ?? [];
  if (publicPaths.length) doc.public_paths = publicPaths;
  const variables = spec.variables as Record<string, string> | undefined;
  if (variables && Object.keys(variables).length) doc.variables = variables;
  const secrets = spec.secrets as Record<string, string> | undefined;
  if (secrets && Object.keys(secrets).length) doc.secrets = secrets;
  return `# boxlite.toml — written by \`boxlite-app app pull\` from spec v${String(spec.version ?? '?')} of environment ${String(spec.environment ?? '?')}\n${stringify(doc)}`;
}
