import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { createApp } from '../src/services/apps.js';
import { harness, type Harness } from './helpers.js';

const GH = { clientId: 'gh-client', clientSecret: 'gh-secret' };
let h: Harness;
afterEach(() => h?.close());

const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/** A fake GitHub for one account; checks the PKCE verifier against the authorize challenge. */
function fakeGithub(id: number, login: string, email: string | null) {
  let challenge = '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('redirect_uri'), 'https://cp.test/auth/callback/github', 'the one registered callback');
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
      return Response.json({ access_token: 'gho_test', token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') return Response.json({ id, login, name: login, avatar_url: null });
    if (url === 'https://api.github.com/user/emails') return Response.json(email ? [{ email, primary: true, verified: true }] : []);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, setChallenge: (c: string) => (challenge = c) };
}

/** Console login → API start → GitHub → API callback → console complete; returns the session cookie. */
async function signIn(gh: ReturnType<typeof fakeGithub>, next = '/console/dashboard/apps'): Promise<{ cookie: string; landed: string }> {
  h.ctx.oauthFetch = gh.fetchImpl;
  const begin = await h.request(`/console/login/github?next=${encodeURIComponent(next)}`);
  assert.equal(begin.status, 302);
  const nonce = cookiePair(begin.headers.get('set-cookie')!);
  const start = await h.request(pathOf(begin.headers.get('location')!));
  assert.equal(start.status, 302, await start.clone().text());
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.origin, 'https://github.com');
  gh.setChallenge(authorize.searchParams.get('code_challenge')!);
  const cb = await h.request(`/auth/callback/github?code=c&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: cookiePair(start.headers.get('set-cookie')!) } });
  assert.equal(cb.status, 302, await cb.clone().text());
  const done = await h.request(pathOf(cb.headers.get('location')!), { headers: { cookie: nonce } });
  assert.equal(done.status, 302, await done.clone().text());
  const session = done.headers.getSetCookie().find((c) => c.includes('bxl_console='));
  assert.ok(session, 'the console origin sets the console session');
  return { cookie: cookiePair(session), landed: done.headers.get('location')! };
}

const api = (cookie: string, path: string, init: { method?: string; json?: unknown } = {}) =>
  h.request(`/console/api${path}`, { ...init, headers: { cookie, 'x-boxlite-console': '1' } });

test('the login page offers GitHub when it is set up, and the admin token as the operator fallback', async () => {
  h = harness({ oauth: { github: GH } });
  const page = await (await h.request('/console/login')).text();
  assert.match(page, /Continue with GitHub/);
  assert.match(page, /admin token/);
  h.close();
  h = harness({ oauth: {} });
  assert.doesNotMatch(await (await h.request('/console/login')).text(), /Continue with GitHub/);
});

test('GitHub sign-in lands in the user org: they see only their Apps, and create into their org', async () => {
  h = harness({ oauth: { github: GH } });
  createApp(h.ctx, 'platform-app');
  const { cookie, landed } = await signIn(fakeGithub(7, 'ann', 'ann@example.com'), '/console/dashboard/apps?x=1');
  assert.equal(landed, '/console/dashboard/apps?x=1');
  const session = await (await api(cookie, '/session')).json();
  assert.equal(session.organization.name, 'Default Organization');
  assert.equal(session.organization.role, 'owner');
  assert.equal(session.profile.login, 'ann');
  assert.deepEqual(await (await api(cookie, '/apps')).json(), [], 'the platform org App is not hers');
  assert.equal((await api(cookie, '/apps/platform-app')).status, 404);
  const created = await api(cookie, '/apps', { method: 'POST', json: { name: 'anns-notes' } });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(h.ctx.store.appByName('anns-notes')!.org_id, session.organization.id);
  assert.deepEqual((await (await api(cookie, '/apps')).json()).map((a: { name: string }) => a.name), ['anns-notes']);

  // Another user never sees it, not even as existing.
  const bob = await signIn(fakeGithub(8, 'bob', 'bob@example.com'));
  assert.equal((await api(bob.cookie, '/apps/anns-notes')).status, 404);
});

test('the legacy owner signs in to the platform org and sees what was there before', async () => {
  h = harness({ oauth: { github: GH } });
  createApp(h.ctx, 'platform-app');
  const { cookie } = await signIn(fakeGithub(9, 'mandalore', 'mandalore@polygala.ai'));
  assert.deepEqual((await (await api(cookie, '/apps')).json()).map((a: { name: string }) => a.name), ['platform-app']);
});

test('a handoff code works once, and only in the browser that began the sign-in', async () => {
  h = harness({ oauth: { github: GH } });
  const gh = fakeGithub(7, 'ann', 'ann@example.com');
  h.ctx.oauthFetch = gh.fetchImpl;
  const begin = await h.request('/console/login/github');
  const start = await h.request(pathOf(begin.headers.get('location')!));
  const authorize = new URL(start.headers.get('location')!);
  gh.setChallenge(authorize.searchParams.get('code_challenge')!);
  const cb = await h.request(`/auth/callback/github?code=c&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: cookiePair(start.headers.get('set-cookie')!) } });
  const complete = pathOf(cb.headers.get('location')!);
  // An attacker's browser (another nonce) cannot use the code.
  const otherBegin = await h.request('/console/login/github');
  assert.equal((await h.request(complete, { headers: { cookie: cookiePair(otherBegin.headers.get('set-cookie')!) } })).status, 400);
  // And once tried, it is gone, even for the right browser.
  assert.equal((await h.request(complete, { headers: { cookie: cookiePair(begin.headers.get('set-cookie')!) } })).status, 400);
});

test('the sign-in page loads its ASCII art from this origin, and the vendor path never leaves its folder', async () => {
  h = harness();
  {
    const page = await (await h.request('/console/login')).text();
    assert.match(page, /<ascii-art piece="rotating-cube"/);
    assert.match(page, /src="\/console\/vendor\/ascii-magic-art\/runtime\/ascii\.js"/);
    assert.doesNotMatch(page, /https:\/\/www\.ascii-magic\.com/, 'nothing loads from a third-party origin');
    const js = await h.request('/console/vendor/ascii-magic-art/runtime/ascii.js');
    assert.equal(js.status, 200, 'public: the page is seen before sign-in');
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal((await h.request('/console/vendor/ascii-magic-art/pieces/rotating-cube.js')).status, 200);
    assert.equal((await h.request('/console/vendor/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await h.request('/console/vendor/ascii-magic-art/nope')).status, 404, 'no SPA fallback here');
  }
});
