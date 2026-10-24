/**
 * Custom domains of an environment (docs/custom-domains.md). Off unless the CP is configured with a
 * CNAME target and the proxy's resolver token: then `app domains add <host>` hands out the two DNS
 * records, `verify` checks the TXT that proves ownership, and only a verified domain is answered
 * to the BoxLite proxy (`GET /proxy/hosts?host=`), as this env's Box and port.
 */
import { resolveTxt, resolveCname } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const CHALLENGE = '_boxlite-challenge';

export interface DomainView {
  host: string;
  env: string;
  status: 'pending_dns' | 'active';
  /** What to add at the DNS provider, until the domain is active. */
  records: { type: 'TXT' | 'CNAME'; name: string; value: string }[];
  verified_at: string | null;
}

interface DomainRow {
  host: string;
  app_id: string;
  env_id: string;
  token: string;
  verified_at: string | null;
}

function configured(ctx: Pick<Ctx, 'config'>): { target: string; resolverToken: string } {
  const c = ctx.config.customDomains;
  if (!c) throw fail('not_supported_yet', 'bringing your own domain is not available on this platform yet', "give the user the app's BoxLite URL (`boxlite-app app status --json`)");
  return c;
}

function view(ctx: Ctx, d: DomainRow): DomainView {
  const env = ctx.store.envById(d.env_id);
  const target = ctx.config.customDomains?.target ?? '';
  return {
    host: d.host,
    env: env?.name ?? '?',
    status: d.verified_at ? 'active' : 'pending_dns',
    records: [
      { type: 'TXT', name: `${CHALLENGE}.${d.host}`, value: d.token },
      { type: 'CNAME', name: d.host, value: target },
    ],
    verified_at: d.verified_at,
  };
}

export function listDomains(ctx: Ctx, app: AppRow, env: EnvRow): DomainView[] {
  return ctx.store.all<DomainRow>('SELECT * FROM app_domains WHERE app_id = ? AND env_id = ? ORDER BY host', app.id, env.id).map((d) => view(ctx, d));
}

export function addDomain(ctx: Ctx, app: AppRow, env: EnvRow, rawHost: string, actor: string): DomainView {
  const { target } = configured(ctx);
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(host)) throw fail('invalid_request', `"${rawHost}" is not a domain name`, 'give the full host, e.g. shop.example.com');
  if (host === target || host.endsWith(`.${new URL(ctx.config.publicUrl).hostname.split('.').slice(1).join('.')}`)) throw fail('invalid_request', `${host} is a platform address, not your own domain`);
  const taken = ctx.store.get<DomainRow>('SELECT * FROM app_domains WHERE host = ?', host);
  if (taken && taken.app_id !== app.id) throw fail('conflict', `${host} is already claimed by another App`, 'if it is yours, remove it there first');
  if (taken) return view(ctx, taken);
  const token = `boxlite-verify=${randomBytes(18).toString('base64url')}`;
  ctx.store.run('INSERT INTO app_domains (host, app_id, env_id, token, created_at) VALUES (?, ?, ?, ?, ?)', host, app.id, env.id, token, now());
  ctx.store.recordActivity(app.id, env.name, actor, 'domain.add', { host });
  return view(ctx, ctx.store.get<DomainRow>('SELECT * FROM app_domains WHERE host = ?', host)!);
}

/** Checks the ownership TXT (and says where the CNAME points); `lookup` is injectable for tests. */
export async function verifyDomain(
  ctx: Ctx,
  app: AppRow,
  env: EnvRow,
  rawHost: string,
  actor: string,
  lookup: { txt: (name: string) => Promise<string[][]>; cname: (name: string) => Promise<string[]> } = { txt: resolveTxt, cname: resolveCname },
): Promise<DomainView & { cname: string | null; cname_ok: boolean }> {
  const { target } = configured(ctx);
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  const d = ctx.store.get<DomainRow>('SELECT * FROM app_domains WHERE host = ? AND app_id = ? AND env_id = ?', host, app.id, env.id);
  if (!d) throw fail('not_found', `${host} is not a domain of ${env.name}`, `\`boxlite-app app domains add ${host}\` first`);
  const txt = (await lookup.txt(`${CHALLENGE}.${host}`).catch(() => [] as string[][])).map((parts) => parts.join(''));
  const cname = (await lookup.cname(host).catch(() => [] as string[]))[0]?.replace(/\.$/, '') ?? null;
  if (!txt.includes(d.token)) {
    throw fail('invalid_request', `${CHALLENGE}.${host} has no TXT record ${d.token} yet${txt.length ? ` (found: ${txt.join(', ')})` : ''}`, `add TXT ${CHALLENGE}.${host} = "${d.token}" at the DNS provider, wait a few minutes, then verify again`, { records: view(ctx, d).records });
  }
  if (!d.verified_at) {
    ctx.store.run('UPDATE app_domains SET verified_at = ? WHERE host = ?', now(), host);
    ctx.store.recordActivity(app.id, env.name, actor, 'domain.verify', { host });
  }
  const out = view(ctx, ctx.store.get<DomainRow>('SELECT * FROM app_domains WHERE host = ?', host)!);
  // The TXT proves ownership; the CNAME only decides whether visitors arrive yet, so it is reported, not required.
  return { ...out, cname, cname_ok: cname === target };
}

export function removeDomain(ctx: Ctx, app: AppRow, env: EnvRow, rawHost: string, actor: string): { removed: string } {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!Number(ctx.store.run('DELETE FROM app_domains WHERE host = ? AND app_id = ? AND env_id = ?', host, app.id, env.id).changes)) {
    throw fail('not_found', `${host} is not a domain of ${env.name}`, '`boxlite-app app domains` lists them');
  }
  ctx.store.recordActivity(app.id, env.name, actor, 'domain.remove', { host });
  return { removed: host };
}

/**
 * The proxy's question: which Box and port serve `host`? Only verified domains of a live, not
 * deleted environment answer; the Box is the one in the env's own URL (the CP serves every App
 * origin on its own Box, one port per environment).
 */
export function resolveHost(ctx: Ctx, rawHost: string): { box_id: string; port: number } | null {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '').split(':')[0]!;
  const d = ctx.store.get<DomainRow>('SELECT * FROM app_domains WHERE host = ? AND verified_at IS NOT NULL', host);
  if (!d) return null;
  const env = ctx.store.envById(d.env_id);
  const app = env ? ctx.store.get<{ deleted_at: string | null }>('SELECT deleted_at FROM apps WHERE id = ?', env.app_id) : undefined;
  if (!env || !app || app.deleted_at) return null;
  const url = env.public_url ?? ctx.origins.envUrl(env);
  const m = /^https?:\/\/(\d+)-([^.]+)\./.exec(url);
  return m ? { box_id: m[2]!, port: Number(m[1]) } : null;
}
