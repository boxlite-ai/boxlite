import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFailedNext } from '../src/check-next.js';

test('a refused deployment says what to do about its first problem, not "run check"', () => {
  assert.match(checkFailedNext([{ file: 'migrations/0001_init.sql', rule: 'migration_changed', message: 'migrations/0001_init.sql was already applied with different contents; add a new migration instead' }]), /git checkout -- migrations\/0001_init\.sql.*migration new <name>/);
  assert.match(checkFailedNext([{ file: 'boxlite.toml', line: 7, rule: 'unknown_field', message: 'unknown field "runtime.colour"' }, { file: 'boxlite.toml', rule: 'x', message: 'y' }]), /^fix boxlite\.toml:7: unknown field "runtime\.colour".*\(2 in all\)/);
  assert.match(checkFailedNext([{ file: 'boxlite.toml', rule: 'stale_base', message: 'stale' }]), /app pull/);
});
