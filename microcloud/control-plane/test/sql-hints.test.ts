import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sqlErrorNext } from '../src/sql-hints.js';

// Shapes as node-postgres reports them (message, code, and the table/column/constraint/detail fields).
test('common Postgres errors get a next step that names what Postgres named', () => {
  assert.match(sqlErrorNext({ code: '42P01', message: 'relation "bookings" does not exist' })!, /no table bookings.*db schema.*migration new/);
  assert.match(sqlErrorNext({ code: '42703', message: 'column "phone" does not exist' })!, /no column phone/);
  assert.match(sqlErrorNext({ code: '23505', constraint: 'slots_starts_at_key', detail: 'Key (starts_at)=(2026-10-23 10:00) already exists.' })!, /slots_starts_at_key: Key \(starts_at\).*ON CONFLICT/);
  assert.match(sqlErrorNext({ code: '23503', constraint: 'bookings_slot_id_fkey', detail: 'Key (slot_id)=(9) is not present in table "slots".' })!, /is not present in table "slots".*insert the referenced row first/);
  assert.match(sqlErrorNext({ code: '23502', column: 'name', table: 'bookings' })!, /column name of bookings needs a value/);
  assert.match(sqlErrorNext({ code: '25006' })!, /--write/);
  assert.equal(sqlErrorNext({ code: 'XX000', message: 'internal' }), undefined, 'nothing better than the generic hint');
});
