import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EMBED_PATH, generateEmbed, generateReference, REFERENCE_PATH, SKILL_PATH } from '../scripts/gen-reference.js';
import { referenceSections, skillSections } from '../src/commands/docs.js';

test('docs/cli-reference.md and the embedded docs are generated from the current definitions', () => {
  const reference = generateReference();
  assert.ok(readFileSync(REFERENCE_PATH, 'utf8') === reference, 'docs/cli-reference.md is stale: run `pnpm --filter @microcloud/cli gen:reference`');
  assert.ok(readFileSync(EMBED_PATH, 'utf8') === generateEmbed(reference, readFileSync(SKILL_PATH, 'utf8')), 'src/generated/docs.ts is stale: run `pnpm --filter @microcloud/cli gen:reference`');
});

test('the reference covers exit codes, JSON shapes and destructive commands', () => {
  const reference = generateReference();
  assert.match(reference, /\| 10 \| `confirmation_required` \|/);
  for (const cmd of ['whoami', 'doctor', 'docs', 'app context', 'app logs', 'app volume cp', 'app curl', 'app db diff', 'app db reset']) {
    assert.equal(referenceSections(cmd.split(' '), reference).length >= 1, true, cmd);
  }
  const reset = referenceSections(['app', 'db', 'reset'], reference)[0]!;
  assert.match(reset, /Destructive: prints what it destroys; needs `--yes`/);
  assert.match(reset, /- `--json`: `\{ reset: string, dropped_tables: string\[\], snapshot: string \}`/);
});

test('SKILL.md sections become docs topics', () => {
  const topics = skillSections(readFileSync(SKILL_PATH, 'utf8')).map((s) => s.topic);
  for (const t of ['install', 'runtime', 'loop', 'verify', 'rules']) assert.ok(topics.includes(t), `${t} in ${topics.join(',')}`);
});
