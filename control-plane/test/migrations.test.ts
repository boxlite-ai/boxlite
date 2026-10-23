import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.js';

const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

// The dev control plane once ran a list where the open_tickets migration had been inserted before an
// already-applied one: it counted that position and never added the columns. Rebuild that state.
test('a database that counted past the open_tickets migration without running it is repaired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-mig-'));
  try {
    const path = join(dir, 'cp.db');
    new Store(path).db.close();
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE open_tickets DROP COLUMN as_email; ALTER TABLE open_tickets DROP COLUMN as_role; ALTER TABLE app_sessions DROP COLUMN role');
    // What dev ran: the first 13 migrations, up to and including the open_tickets slot, not the
    // session role or the repair (an absolute count, so later migrations do not move it).
    db.exec('PRAGMA user_version = 13');
    db.close();

    const store = new Store(path);
    assert.ok(columns(store.db, 'open_tickets').includes('as_email') && columns(store.db, 'open_tickets').includes('as_role'), 'the repair adds the skipped columns');
    assert.ok(columns(store.db, 'app_sessions').includes('role'));
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
