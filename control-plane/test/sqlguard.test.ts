import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/sqlguard.js';
import { MATRIX, type Want, verdict } from './sql-matrix.js';

test(`bypass matrix: ${MATRIX.length} cases`, () => {
  const failures: string[] = [];
  for (const [sql, want, opts] of MATRIX) {
    const c = classify(sql);
    const got: Want = verdict(c);
    if (got !== want) failures.push(`${JSON.stringify(sql)}: want ${want}, got ${got}${c.refused ? ` (${c.refused})` : ''}`);
    if (opts?.n !== undefined && c.statements.length !== opts.n) failures.push(`${JSON.stringify(sql)}: want ${opts.n} statement(s), got ${c.statements.length}`);
    if (opts?.match && !opts.match.test(c.refused ?? '')) failures.push(`${JSON.stringify(sql)}: reason ${JSON.stringify(c.refused)} does not match ${opts.match}`);
  }
  assert.deepEqual(failures, []);
  assert.ok(MATRIX.length >= 40);
});

test('statements keep their own text, sliced on byte offsets', () => {
  const c = classify("SELECT 'é'; /* two */ SELECT 2;");
  assert.deepEqual(
    c.statements.map((s) => s.text),
    ["SELECT 'é'", '/* two */ SELECT 2'],
  );
  assert.deepEqual(
    c.statements.map((s) => s.keyword),
    ['SELECT', 'SELECT'],
  );
});

test('syntax errors carry a 1-based character position like Postgres', () => {
  const c = classify('SELECT é, * FRM t');
  assert.equal(c.syntaxError?.position, 13);
  assert.match(c.syntaxError!.message, /FRM/);
});

test('empty and comment-only queries are refused', () => {
  assert.match(classify('').refused ?? '', /empty/);
  assert.match(classify('-- nothing').refused ?? '', /empty/);
  assert.match(classify(';;').refused ?? '', /empty/);
});
