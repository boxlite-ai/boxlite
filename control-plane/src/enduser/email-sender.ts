/**
 * The App's own SMTP sender for email code sign-in (docs/email-sign-in.md): its settings, the
 * guard that keeps it off the control plane's network, and sending one mail.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';

/** 25 (relay), 465 (implicit TLS), 587 and 2525 (STARTTLS). */
export const SMTP_PORTS = [25, 465, 587, 2525];
const CONNECT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 20_000;

export interface EmailSender {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  from: string;
}

/** What the API and console show: never the password. */
export interface SenderView {
  configured: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  from: string | null;
  password_set: boolean;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** `no-reply@acme.com` or `Acme <no-reply@acme.com>`. */
const FROM_RE = /^(?:[^<>\r\n]{0,100}<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>|([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+))$/;

export function senderOf(ctx: Pick<Ctx, 'store'>, app: AppRow): EmailSender | undefined {
  const r = ctx.store.get<{ host: string; port: number; username: string | null; password: string | null; from_address: string }>(
    'SELECT host, port, username, password, from_address FROM app_email_senders WHERE app_id = ?',
    app.id,
  );
  return r ? { host: r.host, port: r.port, username: r.username, password: r.password, from: r.from_address } : undefined;
}

export function senderView(s: EmailSender | undefined): SenderView {
  return s
    ? { configured: true, host: s.host, port: s.port, username: s.username, from: s.from, password_set: !!s.password }
    : { configured: false, host: null, port: null, username: null, from: null, password_set: false };
}

export interface SenderInput {
  host: string;
  port: number;
  username?: string | null;
  /** Absent: keep the stored one. */
  password?: string | null;
  from: string;
}

export function setSender(ctx: Ctx, app: AppRow, input: SenderInput, actor: string): SenderView {
  const host = input.host.trim().toLowerCase();
  if (!HOST_RE.test(host) && !isIP(host)) throw fail('invalid_request', `"${input.host}" is not a host name`, 'give the SMTP server of the mail provider, e.g. smtp.sendgrid.net');
  if (!ctx.config.smtpAllowPrivate && !SMTP_PORTS.includes(input.port)) throw fail('invalid_request', `port ${input.port} is not an SMTP port`, `use ${SMTP_PORTS.join(', ')} (587 is the usual one)`);
  if (!FROM_RE.test(input.from.trim())) throw fail('invalid_request', `"${input.from}" is not a sender address`, 'give `no-reply@yourdomain.com` or `Your App <no-reply@yourdomain.com>`');
  const kept = senderOf(ctx, app)?.password ?? null;
  const password = input.password === undefined ? kept : input.password || null;
  ctx.store.run(
    `INSERT INTO app_email_senders (app_id, host, port, username, password, from_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id) DO UPDATE SET host = excluded.host, port = excluded.port, username = excluded.username, password = excluded.password, from_address = excluded.from_address, updated_at = excluded.updated_at`,
    app.id,
    host,
    input.port,
    input.username?.trim() || null,
    password,
    input.from.trim(),
    now(),
  );
  ctx.store.recordActivity(app.id, null, actor, 'auth.email.set', { host, port: input.port, from: input.from.trim() });
  return senderView(senderOf(ctx, app));
}

export function removeSender(ctx: Ctx, app: AppRow, actor: string): { removed: boolean } {
  const removed = Number(ctx.store.run('DELETE FROM app_email_senders WHERE app_id = ?', app.id).changes) > 0;
  if (removed) ctx.store.recordActivity(app.id, null, actor, 'auth.email.remove', {});
  return { removed };
}

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges: never a mail server for an App. */
const INTERNAL = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  INTERNAL.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96]] as const) INTERNAL.addSubnet(net, bits, 'ipv6');

/**
 * The address to connect to: the host's, checked to be public (unless the CP allows private ones).
 * Connecting to this address rather than the name means DNS cannot change between check and use.
 */
async function publicAddress(ctx: Pick<Ctx, 'config'>, host: string): Promise<string> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  } catch {
    throw fail('smtp_error', `${host} does not resolve`, 'check the SMTP host name of the mail provider');
  }
  const internal = addrs.find((a) => INTERNAL.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
  if (internal && !ctx.config.smtpAllowPrivate) throw fail('smtp_error', `${host} resolves to ${internal.address}, which is not a public address`, "the sender must be a mail provider's public SMTP server");
  return addrs[0]!.address;
}

/** What to do about an SMTP failure, from nodemailer's error code. */
function smtpHint(code: string | undefined, s: EmailSender): string {
  if (code === 'EAUTH') return 'the server refused the username or password: check them (many providers need an app password or an API key as the password)';
  if (code === 'EENVELOPE') return `the server refused the sender or the recipient: "${s.from}" must be an address the account may send as`;
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'EDNS') return `could not talk to ${s.host}:${s.port}: check the host and port (587 for STARTTLS, 465 for TLS)`;
  if (code === 'ETLS') return `TLS with ${s.host}:${s.port} failed: use 587 (STARTTLS) or 465 (TLS)`;
  return 'check the sender settings with the mail provider, then try again';
}

/** Sends one plain-text mail through the App's sender; throws smtp_error with the server's reply and a hint. */
export async function sendMail(ctx: Pick<Ctx, 'config'>, s: EmailSender, msg: { to: string; subject: string; text: string }): Promise<{ ms: number }> {
  const t0 = Date.now();
  const address = await publicAddress(ctx, s.host);
  // Credentials never cross the network in clear: STARTTLS is required except on implicit-TLS 465.
  const transport = nodemailer.createTransport({
    host: address,
    port: s.port,
    secure: s.port === 465,
    requireTLS: s.port !== 465 && !!s.username && !ctx.config.smtpAllowPrivate,
    tls: { servername: isIP(s.host) ? undefined : s.host },
    auth: s.username ? { user: s.username, pass: s.password ?? '' } : undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({ from: s.from, to: msg.to, subject: msg.subject, text: msg.text });
  } catch (err) {
    const e = err as { code?: string; response?: string; message?: string };
    throw fail('smtp_error', `${s.host}:${s.port}: ${(e.response ?? e.message ?? 'failed').slice(0, 300)}`, smtpHint(e.code, s));
  } finally {
    transport.close();
  }
  return { ms: Date.now() - t0 };
}
