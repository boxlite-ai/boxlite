import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify, type JsonWebKey } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import { isProtected, safeNext } from '../src/enduser/paths.js';
import { signState, verifyState } from '../src/enduser/state.js';
import { oauthClientFor } from '../src/enduser/config.js';
import { signConsoleSession } from '../src/console-auth.js';
import { OAUTH_PROVIDERS } from '../src/oauth-providers.js';
import { ADMIN, createApp, harness, TOML, type Harness } from './helpers.js';

// ---- pure helpers ---------------------------------------------------------------

test('state is signed and expires after 10 minutes', () => {
  const payload = { app: 'crm', env: 'main', next: '/app', provider: 'github', vh: 'abc' };
  const t0 = Date.parse('2026-10-21T10:00:00Z');
  const token = signState('s3cret', payload, 600, t0);
  assert.deepEqual(verifyState('s3cret', token, t0 + 599_000), { ...payload, exp: t0 / 1000 + 600 });
  assert.equal(verifyState('s3cret', token, t0 + 601_000), null, 'expired');
  assert.equal(verifyState('other', token, t0), null, 'wrong key');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, app: 'evil', exp: t0 / 1000 + 600 })).toString('base64url');
  assert.equal(verifyState('s3cret', `${forged}.${mac}`, t0), null, 'tampered body');
  assert.equal(verifyState('s3cret', `${body}.${mac}.x`, t0), null);
  assert.equal(verifyState('s3cret', '', t0), null);
});

test('next must stay on the app origin', () => {
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext('/app/deals?x=1'), '/app/deals?x=1');
  assert.equal(safeNext('dashboard'), '/dashboard');
  for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', '\\\\evil', '/a/../../other', '/%2e%2e/other', '/x\n', 'HTTP://x']) {
    assert.equal(safeNext(bad), null, bad);
  }
});

test('protect globs match the request path', () => {
  const p = ['/app/*', '/admin'];
  for (const yes of ['/app', '/app/', '/app/deals/7', '/app/x?y=1', '/APP/x', '/%61pp/x', '//app/x', '/admin']) assert.ok(isProtected(p, yes), yes);
  for (const no of ['/', '/apple', '/login', '/admin/x', '/api/app/x']) assert.ok(!isProtected(p, no), no);
  assert.ok(!isProtected([], '/app/x'));
  assert.ok(isProtected(['/*'], '/anything/at/all'));
});

// ---- end to end through the CP --------------------------------------------------
//
// Origins (harness): API https://cp.test, crm/main https://10001-cp.test. `h.request` is the API
// origin, `h.appRequest` the env's own origin.

let upstream: Server;
let upstreamUrl: string;
let seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`path=${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(() => upstream.close());

let h: Harness;
afterEach(() => h?.close());

const GH = { clientId: 'gh-client', clientSecret: 'gh-secret' };
const APP_URL = 'https://10001-cp.test';

/** A fake GitHub: checks the PKCE verifier against the challenge from the authorize redirect. */
function fakeGithub(profile: { id: number; login: string; name: string | null; emails: { email: string; primary: boolean; verified: boolean }[] }) {
  const calls: string[] = [];
  let challenge = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), GH.clientId);
      assert.equal(form.get('client_secret'), GH.clientSecret);
      assert.equal(form.get('redirect_uri'), 'https://cp.test/auth/callback/github');
      if (form.get('code') !== 'good-code') return Response.json({ error: 'bad_verification_code' });
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge, 'PKCE verifier matches challenge');
      return Response.json({ access_token: 'gho_test', token_type: 'bearer' });
    }
    const auth = new Headers(init?.headers).get('authorization');
    assert.equal(auth, 'Bearer gho_test');
    if (url === 'https://api.github.com/user') return Response.json({ id: profile.id, login: profile.login, name: profile.name, avatar_url: 'https://avatars.test/1' });
    if (url === 'https://api.github.com/user/emails') return Response.json(profile.emails);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, setChallenge: (c: string) => (challenge = c) };
}

const specFor = (env: string, boxId: string, opts: { auth?: { providers: string[]; protect: string[] } | null; database?: boolean }) => ({
  app: 'crm', environment: env, version: 1, deployment: 1, base_version: 0,
  runtime: { image: 'node', size: 'small', build: [], output: null },
  services: [{ name: 'web', command: 'node s.js', port: 3000 }], schedules: [],
  database: opts.database ? { migrations: 'migrations/', applied: [] } : null, volumes: [],
  auth: opts.auth === undefined ? { providers: ['github', 'google'], protect: ['/app/*'] } : opts.auth,
  domains: { builtin: 'crm', custom: [] }, access: 'public', variables: {}, secrets: {},
  assigned: { box_id: boxId, box_url: upstreamUrl, db_host: null, db_branch: null, app_url: APP_URL },
});

/** App crm, env main live on the local upstream, with this [auth] (and optionally a database). */
async function setup(opts: { auth?: { providers: string[]; protect: string[] } | null; access?: string; database?: boolean; oauth?: Record<string, typeof GH> } = {}) {
  h = harness({ oauth: opts.oauth ?? { github: GH } });
  const key = await createApp(h);
  seen = [];
  const app = h.ctx.store.appByName('crm')!;
  const e = h.ctx.store.envByName(app.id, 'main')!;
  const box = await h.boxlite.createBox({ name: 'app-crm-main' } as never);
  h.ctx.store.updateEnv(e.id, { box_id: box.id, box_url: upstreamUrl, live_deployment: 1, access_override: opts.access ?? 'public', db_url: opts.database ? 'postgresql://u:p@db.test/neondb' : null });
  h.ctx.store.insertSpec(e.id, specFor('main', box.id, opts) as never);
  h.ctx.store.insertDeployment(
    { kind: 'deploy', status: 'live', message: null, by: 'test', created_at: new Date().toISOString(), started_at: null, finished_at: null, spec_version: 1, base_version: 0, snapshot_id: null, steps: [], changes: [], error: null, request: { kind: 'deploy' }, idempotency_key: null, release: 1, box_id: box.id, built: true, restore_point: null, live_at: new Date().toISOString() },
    e.id,
  );
  return { key, app, env: e };
}

/** A second env `dev` of crm with the same [auth], on its own origin. */
function addDevEnv() {
  h.ctx.store.run("INSERT INTO envs (id, app_id, name, created_at, forward_secret, box_id, box_url, live_deployment, access_override) SELECT 'env_dev', app_id, 'dev', created_at, 'g2', box_id, box_url, NULL, 'public' FROM envs WHERE name = 'main'");
  h.ctx.store.insertSpec('env_dev', specFor('dev', 'b', {}) as never);
}

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;

/** Same-origin path + query of an absolute URL on the app origin. */
const local = (url: string) => {
  const u = new URL(url);
  assert.equal(u.origin, APP_URL);
  return u.pathname + u.search;
};

/**
 * The whole browser journey: app-origin login → API /auth/start → fake GitHub → API callback →
 * app-origin /complete. Returns each hop and the session cookie pair.
 */
async function signIn(gh: ReturnType<typeof fakeGithub>, next = '/app/deals'): Promise<{ callback: Response; complete: Response | null; cookie: string }> {
  h.ctx.oauthFetch = gh.fetchImpl;
  const login = await h.appRequest(`/.boxlite/auth/login?provider=github&next=${encodeURIComponent(next)}`);
  assert.equal(login.status, 302);
  const nonce = cookiePair(login.headers.get('set-cookie')!);
  const startUrl = new URL(login.headers.get('location')!);
  assert.equal(startUrl.origin + startUrl.pathname, 'https://cp.test/auth/start');
  const start = await h.request(startUrl.pathname + startUrl.search);
  assert.equal(start.status, 302, await start.clone().text());
  const authorize = new URL(start.headers.get('location')!);
  gh.setChallenge(authorize.searchParams.get('code_challenge')!);
  const verifierCookie = cookiePair(start.headers.get('set-cookie')!);
  const callback = await h.request(`/auth/callback/github?code=good-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: verifierCookie } });
  if (callback.status !== 302) return { callback, complete: null, cookie: '' };
  assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith('__Host-bxl_session=')), 'the API origin never sets the app session');
  const complete = await h.appRequest(local(callback.headers.get('location')!), { headers: { cookie: nonce } });
  const session = complete.headers.getSetCookie().find((c) => c.startsWith('__Host-bxl_session='));
  return { callback, complete, cookie: session ? cookiePair(session) : '' };
}

const octo = { id: 583231, login: 'octocat', name: 'Mona Lisa Octocat', emails: [{ email: 'old@example.com', primary: false, verified: true }, { email: 'mona@example.com', primary: true, verified: true }, { email: 'x@example.com', primary: false, verified: false }] };

test('login on the app origin goes to /auth/start on the API origin, which sets PKCE there and redirects to GitHub', async () => {
  const { env } = await setup();
  const res = await h.appRequest('/.boxlite/auth/login?next=/app/deals');
  assert.equal(res.status, 302);
  const nonce = res.headers.get('set-cookie')!;
  assert.match(nonce, /^__Host-bxl_login=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/, 'binds the sign-in to this browser');
  const bh = createHash('sha256').update(cookiePair(nonce).split('=')[1]!).digest('hex');
  assert.equal(res.headers.get('location'), `https://cp.test/auth/start?app=crm&env=main&provider=github&next=%2Fapp%2Fdeals&bh=${bh}`);

  const start = await h.request(`/auth/start?app=crm&env=main&provider=github&next=%2Fapp%2Fdeals&bh=${bh}`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location')!);
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), GH.clientId);
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://cp.test/auth/callback/github');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const st = verifyState('test-session-secret', loc.searchParams.get('state'))!;
  assert.deepEqual({ app: st.app, env: st.env, next: st.next, provider: st.provider, bh: st.bh }, { app: 'crm', env: 'main', next: '/app/deals', provider: 'github', bh });
  const verifier = start.headers.get('set-cookie')!;
  assert.equal(cookiePair(verifier).split('=')[0], `bxl_pkce_${env.id}`);
  assert.match(verifier, /^bxl_pkce_[\w]+=[\w-]+; Path=\/auth\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.equal(createHash('sha256').update(cookiePair(verifier).split('=')[1]!).digest('hex'), st.vh);

  assert.equal((await h.appRequest('/.boxlite/auth/login?next=//evil.com')).status, 400);
  assert.equal((await h.appRequest('/.boxlite/auth/login?provider=google')).status, 400, 'google has no credentials here');
  assert.equal((await h.request(`/auth/start?app=crm&env=main&provider=google&next=/&bh=${bh}`)).status, 400);
  assert.equal((await h.request(`/auth/start?app=crm&env=main&provider=github&next=https://evil.test&bh=${bh}`)).status, 400);
  assert.equal((await h.request('/auth/start?app=crm&env=main&provider=github&next=/')).status, 400, 'must start on the app origin');
  assert.equal((await h.request('/auth/start?app=nope&env=main&provider=github')).status, 404);
  // /auth/* belongs to the API origin; on the app origin it is the app's path.
  assert.equal(await (await h.appRequest('/auth/start?app=crm')).text(), 'path=/auth/start?app=crm');
});

test('with two configured providers the login page shows one button each', async () => {
  await setup({ oauth: { github: GH, google: { clientId: 'g', clientSecret: 'gs' } } });
  const res = await h.appRequest('/.boxlite/auth/login?next=/app');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Continue with GitHub/);
  assert.match(html, /Continue with Google/);
  assert.match(html, /href="\/.boxlite\/auth\/login\?provider=github&amp;next=%2Fapp"/);
});

test('no configured provider: the login page says sign-in is unavailable', async () => {
  await setup({ oauth: {} });
  assert.equal((await h.appRequest('/.boxlite/auth/login')).status, 503);
});

test('callback upserts and mirrors the user, then a one-time handoff code sets a host-only session on the app origin', async () => {
  await setup({ database: true });
  const gh = fakeGithub(octo);
  const { callback, complete, cookie } = await signIn(gh);
  assert.equal(callback.status, 302, await callback.clone().text());
  const handoff = new URL(callback.headers.get('location')!);
  assert.equal(handoff.origin + handoff.pathname, `${APP_URL}/.boxlite/auth/complete`);
  assert.ok(callback.headers.getSetCookie().some((c) => /^bxl_pkce_\w+=; Path=\/auth\/;.*Max-Age=0/.test(c)), 'verifier cookie cleared');
  const code = handoff.searchParams.get('code')!;
  assert.equal(JSON.stringify(h.ctx.store.all('SELECT * FROM auth_handoffs')).includes(code), false, 'handoff code stored hashed');

  assert.equal(complete!.status, 302);
  assert.equal(complete!.headers.get('location'), '/app/deals');
  const session = complete!.headers.getSetCookie().find((c) => c.startsWith('__Host-bxl_session='))!;
  assert.match(session, /^__Host-bxl_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.doesNotMatch(session, /Domain/i);
  assert.deepEqual(gh.calls, ['https://github.com/login/oauth/access_token', 'https://api.github.com/user', 'https://api.github.com/user/emails']);

  // The code works once, within a minute, on its own env's origin.
  assert.equal((await h.appRequest(local(handoff.href))).status, 400, 'single use');
  const users = h.ctx.store.all<Record<string, unknown>>('SELECT * FROM app_users');
  assert.equal(users.length, 1);
  assert.equal(users[0]!.email, 'mona@example.com', 'primary verified email');
  assert.equal(users[0]!.provider_user_id, '583231');
  assert.match(String(users[0]!.id), /^[0-9a-f-]{36}$/);
  const stmts = h.appdb.queries.flatMap((q) => q.statements);
  assert.ok(stmts.some((s) => s.startsWith('CREATE SCHEMA IF NOT EXISTS boxlite')));
  assert.ok(stmts.some((s) => s.includes('boxlite.current_user_id()')));
  assert.ok(stmts.some((s) => s.startsWith('INSERT INTO boxlite.users')));
  assert.ok(h.appdb.queries.every((q) => q.write));

  const me = await h.appRequest('/.boxlite/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { id: users[0]!.id, email: 'mona@example.com', name: 'Mona Lisa Octocat', provider: 'github', role: 'user', avatar_url: 'https://avatars.test/1' });
  assert.equal((await h.appRequest('/.boxlite/auth/me')).status, 401);

  // Signing in again is the same user.
  await signIn(fakeGithub(octo));
  assert.equal(h.ctx.store.all('SELECT * FROM app_users').length, 1);
});

test('handoff codes work once, for 60 s, on their own env origin, in the browser that started the sign-in', async () => {
  await setup();
  addDevEnv();
  // Login CSRF: a code from someone else's sign-in, pushed into this browser, is refused.
  const attacker = await signInUntilCallback();
  const victim = await h.appRequest('/.boxlite/auth/login?next=/');
  const victimNonce = cookiePair(victim.headers.get('set-cookie')!);
  assert.equal((await h.appRequest(local(attacker.location), { headers: { cookie: victimNonce } })).status, 400, 'another browser');
  assert.equal((await h.appRequest(local(attacker.location))).status, 400, 'no login nonce at all');
  // Another env's origin does not accept it.
  const other = await signInUntilCallback();
  assert.equal((await h.appRequest(new URL(other.location).pathname + new URL(other.location).search, { headers: { cookie: other.nonce } }, 'crm', 'dev')).status, 400);
  const late = await signInUntilCallback();
  h.ctx.store.run('UPDATE auth_handoffs SET expires_at = ?', new Date(Date.now() - 1000).toISOString());
  assert.equal((await h.appRequest(local(late.location), { headers: { cookie: late.nonce } })).status, 400, 'expired');
  assert.equal((await h.appRequest('/.boxlite/auth/complete?code=forged', { headers: { cookie: late.nonce } })).status, 400);
  assert.equal(h.ctx.store.all('SELECT * FROM app_sessions').length, 0);
  // The genuine browser, in time: works.
  const ok = await signInUntilCallback();
  assert.equal((await h.appRequest(local(ok.location), { headers: { cookie: ok.nonce } })).status, 302);
  assert.equal((await h.appRequest(local(ok.location), { headers: { cookie: ok.nonce } })).status, 400, 'single use');
  assert.equal(h.ctx.store.all('SELECT * FROM app_sessions').length, 1);
});

/** Runs the flow from the app-origin login up to the callback; returns its redirect to /complete and the login nonce cookie. */
async function signInUntilCallback(): Promise<{ location: string; nonce: string }> {
  const gh = fakeGithub(octo);
  h.ctx.oauthFetch = gh.fetchImpl;
  const login = await h.appRequest('/.boxlite/auth/login?provider=github&next=%2F');
  const nonce = cookiePair(login.headers.get('set-cookie')!);
  const startUrl = new URL(login.headers.get('location')!);
  const start = await h.request(startUrl.pathname + startUrl.search);
  const authorize = new URL(start.headers.get('location')!);
  gh.setChallenge(authorize.searchParams.get('code_challenge')!);
  const cb = await h.request(`/auth/callback/github?code=good-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: cookiePair(start.headers.get('set-cookie')!) } });
  assert.equal(cb.status, 302);
  return { location: cb.headers.get('location')!, nonce };
}

test('callback refuses a forged state, a missing verifier cookie and a bad code', async () => {
  const { env } = await setup();
  const gh = fakeGithub(octo);
  h.ctx.oauthFetch = gh.fetchImpl;
  const start = await h.request(`/auth/start?app=crm&env=main&provider=github&next=/app&bh=${'0'.repeat(64)}`);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const verifierCookie = cookiePair(start.headers.get('set-cookie')!);

  assert.equal((await h.request(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state + 'x')}`, { headers: { cookie: verifierCookie } })).status, 400);
  assert.equal((await h.request(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state)}`)).status, 400, 'no verifier cookie: another browser');
  assert.equal((await h.request(`/auth/callback/google?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: verifierCookie } })).status, 400, 'provider mismatch');
  const bad = await h.request(`/auth/callback/github?code=bad&state=${encodeURIComponent(state)}`, { headers: { cookie: verifierCookie } });
  assert.equal(bad.status, 502);
  const text = await bad.text();
  // The visitor gets plain words; the provider's answer goes to the env's auth log for its owner.
  assert.match(text, /GitHub sign-in failed/);
  assert.ok(!text.includes('bad_verification_code'), 'no provider internals on the page');
  assert.ok(h.ctx.store.logs(env.id, { source: 'auth', limit: 10 }).some((l) => l.line.includes('bad_verification_code')));
  assert.ok(text.includes(`href="${APP_URL}/.boxlite/auth/login?next=%2Fapp"`), 'Try again goes back to the app origin');
  const cancelled = await h.request(`/auth/callback/github?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie: verifierCookie } });
  assert.equal(cancelled.status, 400);
  assert.equal(h.ctx.store.all('SELECT * FROM auth_handoffs').length, 0);
  assert.equal(h.ctx.store.all('SELECT * FROM app_sessions').length, 0);
});

test('the proxy strips spoofed identity headers and injects the signed-in user', async () => {
  await setup();
  const spoof = { 'x-boxlite-user-id': 'spoof', 'x-boxlite-user-email': 'spoof@x', 'x-boxlite-identity': 'forged.jwt.value' };

  const anon = await h.appRequest('/api/items', { headers: spoof });
  assert.equal(anon.status, 200);
  for (const k of Object.keys(spoof)) assert.equal(seen[0]!.headers[k], undefined, k);

  const { cookie } = await signIn(fakeGithub({ ...octo, name: 'Zoë 李' }));
  seen = [];
  const res = await h.appRequest('/api/items', { headers: { ...spoof, cookie: `${cookie}; theme=dark` } });
  assert.equal(res.status, 200);
  const got = seen[0]!.headers;
  const user = h.ctx.store.get<{ id: string }>('SELECT id FROM app_users')!;
  assert.equal(got['x-boxlite-user-id'], user.id);
  assert.equal(got['x-boxlite-user-email'], 'mona@example.com');
  assert.equal(decodeURIComponent(String(got['x-boxlite-user-name'])), 'Zoë 李');
  assert.equal(got['x-boxlite-user-provider'], 'github');
  assert.equal(String(got['x-boxlite-identity']).split('.').length, 3);
  assert.equal(got.cookie, 'theme=dark', 'the session cookie never reaches the app');

  // Sessions are per app env: the same cookie sent to another env's origin does nothing.
  addDevEnv();
  assert.equal((await h.appRequest('/.boxlite/auth/me', { headers: { cookie } }, 'crm', 'dev')).status, 401);
  assert.equal((await h.appRequest('/.boxlite/auth/me', { headers: { cookie } })).status, 200);
});

test('protected paths: browsers are sent to login, API calls get 401 JSON', async () => {
  await setup();
  const page = await h.appRequest('/app/deals?tab=2', { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/.boxlite/auth/login?next=%2Fapp%2Fdeals%3Ftab%3D2');
  const api = await h.appRequest('/app/deals', { headers: { accept: 'application/json' } });
  assert.equal(api.status, 401);
  const body = (await api.json()) as { error: { code: string; message: string; next: string } };
  assert.deepEqual([body.error.code, body.error.message], ['unauthenticated', 'sign in required']);
  assert.match(body.error.next, /\/\.boxlite\/auth\/login\?next=/, 'the 401 says where users sign in');
  const post = await h.appRequest('/app/deals', { method: 'POST', headers: { accept: 'text/html' } });
  assert.equal(post.status, 401);
  assert.equal(seen.length, 0);

  assert.equal((await h.appRequest('/', { headers: { accept: 'text/html' } })).status, 200, 'unprotected');
  const { cookie } = await signIn(fakeGithub(octo));
  assert.equal((await h.appRequest('/app/deals', { headers: { cookie } })).status, 200);
});

test('a private app still needs the access gate before login applies', async () => {
  const { key } = await setup({ access: 'private' });
  assert.equal((await h.appRequest('/.boxlite/auth/login')).status, 401, 'access gate first');
  assert.equal((await h.appRequest('/.boxlite/auth/complete?code=x')).status, 401, 'complete is behind the gate too');
  const { url } = (await (await h.request('/v1/apps/crm/envs/main/open-ticket', { method: 'POST', key })).json()) as { url: string };
  const open = await h.appRequest(local(url));
  const gate = cookiePair(open.headers.get('set-cookie')!);
  const res = await h.appRequest('/app/x', { headers: { cookie: gate, accept: 'text/html' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location')!, /^\/\.boxlite\/auth\/login/);
  // The public key is reachable without the gate: app servers fetch it from their own origin.
  assert.equal((await h.appRequest('/.boxlite/auth/jwks.json')).status, 200);
});

test('logout revokes the session and clears the cookie', async () => {
  await setup();
  const { cookie } = await signIn(fakeGithub(octo));
  const out = await h.appRequest('/.boxlite/auth/logout?next=/bye', { headers: { cookie } });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/bye');
  assert.match(out.headers.get('set-cookie')!, /^__Host-bxl_session=; Path=\/;.*Max-Age=0/);
  assert.equal((await h.appRequest('/.boxlite/auth/me', { headers: { cookie } })).status, 401);
});

test('blocking a user revokes their sessions and the next sign-in gets the no-access page', async () => {
  const { key } = await setup();
  const { cookie } = await signIn(fakeGithub(octo));
  const user = h.ctx.store.get<{ id: string }>('SELECT id FROM app_users')!;

  const blocked = await h.request(`/v1/apps/crm/envs/main/auth/users/${user.id}/block`, { method: 'POST', key });
  assert.equal(blocked.status, 200);
  assert.equal(((await blocked.json()) as { blocked: boolean }).blocked, true);
  seen = [];
  await h.appRequest('/api', { headers: { cookie } });
  assert.equal(seen[0]!.headers['x-boxlite-user-id'], undefined, 'old session no longer works');

  const again = await signIn(fakeGithub(octo));
  assert.equal(again.callback.status, 403);
  assert.match(await again.callback.text(), /You don&#39;t have access to this site|You don't have access to this site/);
  assert.equal(again.cookie, '');

  assert.equal((await h.request(`/v1/apps/crm/envs/main/auth/users/${user.id}/unblock`, { method: 'POST', key })).status, 200);
  assert.equal((await signIn(fakeGithub(octo))).complete!.status, 302);
  const actions = h.ctx.store.all<{ action: string }>("SELECT action FROM activity WHERE action LIKE 'auth.%' ORDER BY id").map((a) => a.action);
  assert.deepEqual(actions, ['auth.user.block', 'auth.user.unblock']);
});

test('test-session gives an agent a 15-minute cookie for a test user on the app origin', async () => {
  const { key } = await setup();
  const res = await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'QA@example.com' } });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { cookie: string; cookie_name: string; expires_in: string; expires_at: string; user: { email: string; provider: string } };
  assert.match(body.cookie, /^__Host-bxl_session=[\w-]+$/);
  assert.equal(body.cookie_name, '__Host-bxl_session');
  assert.equal(body.expires_in, '15m');
  assert.ok(Math.abs(Date.parse(body.expires_at) - Date.now() - 15 * 60_000) < 5000);
  assert.deepEqual([body.user.email, body.user.provider], ['qa@example.com', 'test']);

  // What an agent does to verify sign-in on a private app: the App key plus the test session.
  const me = await h.appRequest('/.boxlite/auth/me', { headers: { cookie: body.cookie, authorization: `Bearer ${key}` } });
  assert.equal(me.status, 200, 'the CP answers /.boxlite/auth/me; it never reaches the app');
  assert.equal(((await me.json()) as { email: string }).email, 'qa@example.com');

  seen = [];
  assert.equal((await h.appRequest('/app/x', { headers: { cookie: body.cookie } })).status, 200);
  assert.equal(seen[0]!.headers['x-boxlite-user-email'], 'qa@example.com');
  assert.equal(seen[0]!.headers['x-boxlite-user-provider'], 'test');
  const again = (await (await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'qa@example.com' } })).json()) as { user: { id: string } };
  assert.equal(h.ctx.store.all('SELECT * FROM app_users').length, 1, 'reuses the user');
  assert.ok(again.user.id);
  const audit = h.ctx.store.all<{ action: string; detail: string }>("SELECT action, detail FROM activity WHERE action = 'auth.test_session'");
  assert.equal(audit.length, 2);
  assert.equal(JSON.parse(audit[0]!.detail).email, 'qa@example.com');

  assert.equal((await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'nope' } })).status, 400);
});

test('test-session without [auth] is a conflict', async () => {
  const { key } = await setup({ auth: null });
  const res = await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'qa@example.com' } });
  assert.equal(res.status, 409);
});

/** What SKILL.md rule 8 tells apps to do: signature, iss, and aud === BOXLITE_APP_URL. */
function verifyIdentity(jwt: string, keys: (JsonWebKey & { kid: string })[], appUrl: string): Record<string, unknown> | null {
  const [h64, p64, s64] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h64, 'base64url').toString());
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  if (!verify('sha256', Buffer.from(`${h64}.${p64}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s64, 'base64url'))) return null;
  const claims = JSON.parse(Buffer.from(p64, 'base64url').toString());
  if (claims.iss !== 'https://cp.test/auth' || claims.aud !== appUrl || claims.exp < Date.now() / 1000) return null;
  return claims;
}

test('X-BoxLite-Identity is an RS256 JWT bound to the app origin (aud) that verifies against the JWKS', async () => {
  const { key } = await setup();
  const { cookie } = (await (await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'qa@example.com' } })).json()) as { cookie: string };
  seen = [];
  await h.appRequest('/', { headers: { cookie } });
  const jwt = String(seen[0]!.headers['x-boxlite-identity']);
  const [h64, p64, s64] = jwt.split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h64, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p64, 'base64url').toString());

  const set = (await (await h.appRequest('/.boxlite/auth/jwks.json')).json()) as { keys: (JsonWebKey & { kid: string })[] };
  assert.deepEqual(await (await h.request('/auth/jwks.json')).json(), set);
  const jwk = set.keys.find((k) => k.kid === header.kid)!;
  assert.ok(jwk, 'kid is in the JWKS');
  assert.equal(header.alg, 'RS256');
  assert.ok(verify('sha256', Buffer.from(`${h64}.${p64}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s64, 'base64url')));
  assert.ok(!verify('sha256', Buffer.from(`${h64}.${p64}x`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s64, 'base64url')));
  const user = h.ctx.store.get<{ id: string }>('SELECT id FROM app_users')!;
  assert.deepEqual({ ...claims, iat: 0, exp: claims.exp - claims.iat }, { iss: 'https://cp.test/auth', aud: APP_URL, sub: user.id, email: 'qa@example.com', name: 'qa', provider: 'test', role: 'user', app: 'crm', env: 'main', iat: 0, exp: 300 });

  // F4: app crm's token is valid for crm and refused by any other app that checks aud.
  assert.ok(verifyIdentity(jwt, set.keys, h.ctx.resources.runtimeEnv(h.ctx.store.appByName('crm')!, h.ctx.store.envByName(h.ctx.store.appByName('crm')!.id, 'main')!, undefined).BOXLITE_APP_URL!));
  await createApp(h, 'ledger');
  assert.equal(verifyIdentity(jwt, set.keys, h.appUrl('ledger')), null);

  // The key is persisted, so a restarted CP signs with the same kid.
  assert.match(String((await import('node:fs')).readFileSync(`${h.dir}/enduser-identity-key.pem`, 'utf8')), /BEGIN PRIVATE KEY/);
});

test('status, redirect URIs, users, search, sign-out and CSV export', async () => {
  const { key } = await setup();
  await signIn(fakeGithub(octo));
  await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'qa@example.com' } });

  const status = await (await h.request('/v1/apps/crm/envs/main/auth', { key })).json();
  assert.deepEqual(status, {
    enabled: true,
    providers: [{ name: 'github', status: 'ready' }, { name: 'google', status: 'not_configured' }],
    protect: ['/app/*'],
    login_url: `${APP_URL}/.boxlite/auth/login`,
    users: 2,
  });
  assert.deepEqual(await (await h.request('/v1/apps/crm/envs/main/auth/redirect-uris', { key })).json(), [
    { provider: 'github', redirect_uri: 'https://cp.test/auth/callback/github', status: 'ready' },
    { provider: 'google', redirect_uri: 'https://cp.test/auth/callback/google', status: 'not_configured' },
    ...['microsoft', 'apple', 'x', 'facebook'].map((p) => ({ provider: p, redirect_uri: `https://cp.test/auth/callback/${p}`, status: 'not_configured' })),
  ]);

  const found = (await (await h.request('/v1/apps/crm/envs/main/auth/users?search=mona', { key })).json()) as { id: string; email: string; active_sessions: number }[];
  assert.deepEqual(found.map((u) => [u.email, u.active_sessions]), [['mona@example.com', 1]]);
  assert.equal(((await (await h.request('/v1/apps/crm/envs/main/auth/users?search=%25', { key })).json()) as unknown[]).length, 0, 'LIKE wildcards are literal');

  const out = (await (await h.request(`/v1/apps/crm/envs/main/auth/users/${found[0]!.id}/signout`, { method: 'POST', key })).json()) as { revoked: number; active_sessions: number };
  assert.deepEqual([out.revoked, out.active_sessions], [1, 0]);
  assert.equal((await h.request('/v1/apps/crm/envs/main/auth/users/nope/signout', { method: 'POST', key })).status, 404);

  const csv = await h.request('/v1/apps/crm/envs/main/auth/users/export', { key });
  assert.match(csv.headers.get('content-type')!, /^text\/csv/);
  const lines = (await csv.text()).trim().split('\n');
  assert.equal(lines[0], 'id,email,name,provider,first_seen,last_seen,blocked');
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes(',mona@example.com,Mona Lisa Octocat,github,')));
});

test('plan accepts github and google and warns about the unconfigured one', async () => {
  const { key } = await setup();
  const res = await h.request('/v1/apps/crm/envs/main/plan', { method: 'POST', key, json: { manifest: TOML + '\n[auth]\nproviders = ["github", "google"]\n', base_version: 1 } });
  const plan = (await res.json()) as { errors: unknown[]; warnings: { rule: string; message: string }[] };
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings.filter((w) => w.rule.startsWith('auth')), [{ rule: 'auth_provider_not_configured', message: 'google: not configured on this platform yet' }]);
});

test('"auth" cannot be an app name', async () => {
  h = harness();
  const res = await h.request('/v1/apps', { method: 'POST', key: ADMIN, json: { name: 'auth' } });
  assert.equal(res.status, 400);
});

test('apps without [auth] pass through untouched and have no auth routes', async () => {
  await setup({ auth: null });
  await h.appRequest('/x', { headers: { 'x-boxlite-identity': 'forged' } });
  assert.equal(seen[0]!.headers['x-boxlite-identity'], undefined);
  assert.equal((await h.appRequest('/.boxlite/auth/login')).status, 404);
});

test('the supervisor control API under /.boxlite/ is never reachable on an app origin', async () => {
  await setup({ auth: null });
  for (const path of ['/.boxlite/sv/health', '/.boxlite%2Fsv/restart', '/.BOXLITE/sv/logs', '/x/%2e%2e/.boxlite/sv/deploy', '/.boxlite/auth/../sv/deploy', '/%2eboxlite/sv/health', '/.boxlite', '/.boxlite/open/../sv/deploy']) {
    const res = await h.appRequest(path, { method: path.endsWith('health') || path.endsWith('logs') ? 'GET' : 'POST' });
    assert.equal(res.status, 404, path);
  }
  // With [auth] on, the auth prefix does not open a way through either.
  h.close();
  await setup();
  for (const path of ['/.boxlite/auth/../sv/deploy', '/.boxlite/auth/%2e%2e/sv/deploy', '/.boxlite/authx']) assert.equal((await h.appRequest(path, { method: 'POST' })).status, 404, path);
  assert.equal(seen.length, 0);
});

// ---- providers that need the App's own OAuth app --------------------------------

const idToken = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('Apple signs in through its form POST callback, with an ES256 client secret signed by the App key', async () => {
  const { app, env } = await setup({ auth: { providers: ['apple'], protect: [] } });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
  h.ctx.store.run("INSERT INTO app_oauth_clients (app_id, provider, client_id, client_secret, updated_at) VALUES (?, 'apple', 'com.example.web', ?, '')", app.id, JSON.stringify(key));
  let secretChecked = false;
  h.ctx.oauthFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://appleid.apple.com/auth/token');
    const body = new URLSearchParams(String(init!.body));
    assert.equal(body.get('code'), 'apple-code');
    const [head, claims, sig] = body.get('client_secret')!.split('.');
    assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')), 'signed with the App key');
    const c = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    assert.deepEqual({ iss: c.iss, sub: c.sub, aud: c.aud, kid: JSON.parse(Buffer.from(head!, 'base64url').toString()).kid }, { iss: 'TEAM123456', sub: 'com.example.web', aud: 'https://appleid.apple.com', kid: 'KEY1234567' });
    secretChecked = true;
    return new Response(JSON.stringify({ id_token: idToken({ sub: '001234.abc', email: 'ann@privaterelay.appleid.com', email_verified: 'true' }) }));
  }) as typeof fetch;

  const login = await h.appRequest('/.boxlite/auth/login?provider=apple&next=/app');
  const nonce = cookiePair(login.headers.get('set-cookie')!);
  const startUrl = new URL(login.headers.get('location')!);
  const start = await h.request(startUrl.pathname + startUrl.search);
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.origin + authorize.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(authorize.searchParams.get('response_mode'), 'form_post');
  const verifier = start.headers.get('set-cookie')!;
  // Apple POSTs back from its own site: a Lax cookie would not come with it.
  assert.match(verifier, /SameSite=None/);

  const callback = await h.request('/auth/callback/apple', {
    method: 'POST',
    headers: { cookie: cookiePair(verifier), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'apple-code', state: authorize.searchParams.get('state')! }).toString(),
  });
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.ok(secretChecked);
  const complete = await h.appRequest(local(callback.headers.get('location')!), { headers: { cookie: nonce } });
  assert.ok(complete.headers.getSetCookie().some((c) => c.startsWith('__Host-bxl_session=')), 'signed in');
  const user = h.ctx.store.get<{ provider: string; email: string }>('SELECT provider, email FROM app_users WHERE env_id = ?', env.id)!;
  assert.deepEqual({ ...user }, { provider: 'apple', email: 'ann@privaterelay.appleid.com' });
});

test('Microsoft, X and Facebook map their accounts to a user; only verified or provider-confirmed email is kept', async () => {
  h = harness();
  const creds = { clientId: 'cid', clientSecret: 'csecret' };
  const replies: Record<string, unknown> = {
    'https://login.microsoftonline.com/common/oauth2/v2.0/token': { id_token: idToken({ sub: 'ms-sub', email: 'ann@contoso.com', name: 'Ann' }) },
    'https://api.x.com/2/oauth2/token': { access_token: 'xt' },
    'https://api.x.com/2/users/me?user.fields=profile_image_url': { data: { id: '42', name: 'Ann', username: 'ann', profile_image_url: 'https://pbs.twimg.com/a.jpg' } },
    'https://graph.facebook.com/v21.0/oauth/access_token': { access_token: 'ft' },
    'https://graph.facebook.com/v21.0/me': { id: 'fb1', name: 'Ann', email: 'ann@example.com', picture: { data: { url: 'https://fb/a.jpg' } } },
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = Object.keys(replies).find((k) => url === k || url.startsWith(`${k}?`));
    return new Response(JSON.stringify(hit ? replies[hit] : { error: 'unexpected' }), { status: hit ? 200 : 404 });
  }) as typeof fetch;
  const run = (name: string) => OAUTH_PROVIDERS[name]!.signIn({ creds, redirectUri: `https://cp.test/auth/callback/${name}`, code: 'c', codeVerifier: 'v', fetch: fetchImpl });
  assert.deepEqual(await run('microsoft'), { id: 'ms-sub', email: 'ann@contoso.com', name: 'Ann', avatarUrl: null });
  assert.deepEqual(await run('x'), { id: '42', email: null, name: 'Ann', avatarUrl: 'https://pbs.twimg.com/a.jpg', login: 'ann' });
  assert.match(String(calls.find((c) => c.url.startsWith('https://api.x.com/2/oauth2/token'))!.init!.headers && (calls.find((c) => c.url.startsWith('https://api.x.com/2/oauth2/token'))!.init!.headers as Record<string, string>).authorization), /^Basic /, 'X takes the client secret as Basic auth');
  assert.deepEqual(await run('facebook'), { id: 'fb1', email: 'ann@example.com', name: 'Ann', avatarUrl: 'https://fb/a.jpg' });
});

test('providers BoxLite runs no OAuth app for take only the App\'s own, from the console', async () => {
  const { app } = await setup({ oauth: { github: GH, microsoft: { clientId: 'platform', clientSecret: 'platform' } } });
  assert.equal(oauthClientFor(h.ctx, app, 'microsoft'), undefined, 'a platform-wide Microsoft app is never used');
  const cookie = `__Host-bxl_console=${signConsoleSession('test-session-secret')}`;
  const put = (provider: string, json: unknown) =>
    h.request(`/console/api/apps/crm/auth/methods/${provider}`, { method: 'PUT', json, headers: { cookie, 'x-boxlite-console': '1' } });
  const shared = await put('apple', { keys: 'shared' });
  assert.equal(shared.status, 400, await shared.clone().text());
  const missing = await put('apple', { keys: 'own', clientId: 'com.example.web', teamId: 'TEAM123456' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error.message, /Key ID and the private key/);
  const ok = await put('microsoft', { keys: 'own', clientId: 'my-ms-app', clientSecret: 'my-ms-secret' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const method = (await ok.json()).status.methods.find((m: { provider: string }) => m.provider === 'microsoft');
  assert.deepEqual({ label: method.label, status: method.status, keys: method.keys, managed: method.managedAvailable }, { label: 'Microsoft', status: 'ready', keys: 'own', managed: false });
});

// ---- the visitor's role -----------------------------------------------------------

test('a visitor is owner when the same GitHub account manages the App in the console; a forged role is dropped', async () => {
  const { app } = await setup();
  const { cookie } = await signIn(fakeGithub(octo));
  const roleNow = async () => {
    seen = [];
    await h.appRequest('/api/items', { headers: { cookie, 'x-boxlite-user-role': 'owner' } });
    const me = (await (await h.appRequest('/.boxlite/auth/me', { headers: { cookie } })).json()) as { role: string };
    const jwt = JSON.parse(Buffer.from(String(seen[0]!.headers['x-boxlite-identity']).split('.')[1]!, 'base64url').toString());
    return [seen[0]!.headers['x-boxlite-user-role'], me.role, jwt.role];
  };
  assert.deepEqual(await roleNow(), ['user', 'user', 'user'], 'a stranger, whatever header the browser sends');

  // The same GitHub account (numeric id) signs in to the console and is in the App's organization.
  h.ctx.store.run("INSERT INTO console_users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('cu_1', 'github', ?, 'octocat', '', '')", String(octo.id));
  h.ctx.store.run("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('org_other', 'cu_1', 'owner', '')");
  assert.deepEqual(await roleNow(), ['user', 'user', 'user'], 'a member of another organization is not');
  h.ctx.store.run("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?, 'cu_1', 'member', '')", app.org_id ?? 'org_platform');
  assert.deepEqual(await roleNow(), ['owner', 'owner', 'owner']);
});

test('test sessions take a role, so an agent can check both sides of an owner-only page', async () => {
  const { key } = await setup();
  const session = async (json: object) => (await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json })).json() as Promise<{ cookie: string; role: string }>;
  const owner = await session({ email: 'boss@example.com', role: 'owner' });
  assert.equal(owner.role, 'owner');
  seen = [];
  await h.appRequest('/admin', { headers: { cookie: owner.cookie } });
  assert.equal(seen[0]!.headers['x-boxlite-user-role'], 'owner');
  const plain = await session({ email: 'boss@example.com' });
  seen = [];
  await h.appRequest('/admin', { headers: { cookie: plain.cookie } });
  assert.equal(seen[0]!.headers['x-boxlite-user-role'], 'user', 'a new session without a role is a plain user again');
  assert.equal((await h.request('/v1/apps/crm/envs/main/auth/test-sessions', { method: 'POST', key, json: { email: 'a@b.c', role: 'admin' } })).status, 400);
});
