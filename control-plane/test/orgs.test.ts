import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PLATFORM_ORG, UNVERIFIED_EMAIL_REASON, assertCanCreate, canSee, orgIdFor, orgSecret, signInConsoleUser, viewerOf, type Viewer } from '../src/orgs.js';
import { createApp } from '../src/services/apps.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
before(() => {
  h = harness();
});
after(() => h.close());

const gh = (id: string, email: string | null, login = `u${id}`) => ({ id, email, name: login, avatarUrl: null, login });
const viewer = (userId: string): Extract<Viewer, { kind: 'user' }> => {
  const v = viewerOf(h.ctx, userId);
  assert.ok(v && v.kind === 'user', 'a signed-in user has a viewer');
  return v;
};

test('a first sign-in creates the user a Default Organization they own; signing in again keeps it', () => {
  const u = signInConsoleUser(h.ctx, 'github', gh('101', 'ann@example.com'));
  const v = viewer(u.id);
  assert.equal(v.org.name, 'Default Organization');
  assert.equal(v.role, 'owner');
  assert.notEqual(v.org.id, PLATFORM_ORG);
  assert.equal(v.org.app_limit, 3);
  signInConsoleUser(h.ctx, 'github', gh('101', 'ann@example.com'));
  assert.equal(viewer(u.id).org.id, v.org.id);
});

test('the legacy owner takes the platform org, with everything from before organizations; nobody else can', () => {
  const before = createApp(h.ctx, 'legacy-app').app;
  assert.equal(before.org_id, PLATFORM_ORG);
  const owner = viewer(signInConsoleUser(h.ctx, 'github', gh('202', 'mandalore@polygala.ai')).id);
  assert.equal(owner.org.id, PLATFORM_ORG);
  assert.equal(owner.org.app_limit, null, 'the platform org has no App limit');
  assert.ok(canSee(owner, before));
  // A second account with the same email (another provider id) gets its own org.
  const other = viewer(signInConsoleUser(h.ctx, 'github', gh('203', 'mandalore@polygala.ai')).id);
  assert.notEqual(other.org.id, PLATFORM_ORG);
  assert.ok(!canSee(other, before));
});

test('Apps belong to the creator org: other orgs cannot see them, the admin sees all', () => {
  const ann = viewer(signInConsoleUser(h.ctx, 'github', gh('101', 'ann@example.com')).id);
  const bob = viewer(signInConsoleUser(h.ctx, 'github', gh('301', 'bob@example.com')).id);
  const app = createApp(h.ctx, 'anns-app', 'console', orgIdFor(ann)).app;
  assert.ok(canSee(ann, app));
  assert.ok(!canSee(bob, app));
  assert.ok(canSee({ kind: 'admin' }, app));
});

test('an org secret resolves only for Apps of its org', () => {
  h.ctx.store.run('INSERT INTO org_secrets (org_id, name, value, updated_at) VALUES (?, ?, ?, ?)', PLATFORM_ORG, 'org/openai', 'sk-platform', new Date().toISOString());
  const mine = h.ctx.store.appByName('legacy-app')!;
  const theirs = h.ctx.store.appByName('anns-app')!;
  assert.equal(orgSecret(h.ctx, mine, 'org/openai'), 'sk-platform');
  assert.equal(orgSecret(h.ctx, theirs, 'org/openai'), undefined);
});

test('a new org holds at most 3 Apps; an account without a verified email is suspended until it has one', () => {
  const carl = viewer(signInConsoleUser(h.ctx, 'github', gh('401', 'carl@example.com')).id);
  for (const n of [1, 2, 3]) {
    assertCanCreate(h.ctx, carl);
    createApp(h.ctx, `carl-${n}`, 'console', orgIdFor(carl));
  }
  assert.throws(() => assertCanCreate(h.ctx, carl), /already has 3 Apps/);

  const dana = signInConsoleUser(h.ctx, 'github', gh('501', null));
  assert.equal(viewer(dana.id).org.suspended_reason, UNVERIFIED_EMAIL_REASON);
  assert.throws(() => assertCanCreate(h.ctx, viewer(dana.id)), /suspended/);
  signInConsoleUser(h.ctx, 'github', gh('501', 'dana@example.com'));
  assert.equal(viewer(dana.id).org.suspended_reason, null);
  assertCanCreate(h.ctx, viewer(dana.id));
});
