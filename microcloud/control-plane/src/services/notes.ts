/**
 * Notes an agent keeps for the next session on the same App (the CLI's app remember, recall, forget):
 * the owner's preferences and the decisions behind the code, which neither the code nor the spec
 * records. App-wide, plain text, never a credential; the newest appear in `app context`.
 */
import { secretKindIn, type AppNote } from '@microcloud/shared';
import type { AppRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';

export const MAX_NOTE_CHARS = 2000;
export const MAX_NOTES = 200;

export function addNote(ctx: Ctx, app: AppRow, text: string, actor: string): AppNote {
  const t = text.trim();
  if (!t) throw fail('invalid_request', 'the note is empty', 'write the fact or decision the next session needs, e.g. `boxlite-app app remember "the owner wants prices in CNY with no decimals"`');
  if (t.length > MAX_NOTE_CHARS) throw fail('invalid_request', `the note is ${t.length} characters; the limit is ${MAX_NOTE_CHARS}`, 'keep one fact or decision per note');
  const secret = secretKindIn(t);
  if (secret) throw fail('invalid_request', `the note contains ${secret}; notes are plain text that every session reads`, 'store the value as a secret (`boxlite-app app secrets set <name>`) and note only its name');
  const count = ctx.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM app_notes WHERE app_id = ?', app.id)?.n ?? 0;
  if (count >= MAX_NOTES) throw fail('conflict', `this App already has ${MAX_NOTES} notes`, 'forget the ones that no longer hold: `boxlite-app app recall`, then `boxlite-app app forget <id>`');
  const r = ctx.store.run('INSERT INTO app_notes (app_id, text, by, created_at) VALUES (?, ?, ?, ?)', app.id, t, actor, now());
  ctx.store.recordActivity(app.id, null, actor, 'note.add', { id: Number(r.lastInsertRowid) });
  return { id: Number(r.lastInsertRowid), text: t, by: actor, created_at: now() };
}

/** Newest first; `query` matches words in any order, case-insensitively. */
export function listNotes(ctx: Ctx, app: AppRow, opts: { query?: string; limit?: number } = {}): AppNote[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_NOTES);
  const words = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = ctx.store.all<AppNote>('SELECT id, text, by, created_at FROM app_notes WHERE app_id = ? ORDER BY id DESC', app.id);
  return rows.filter((n) => words.every((w) => n.text.toLowerCase().includes(w))).slice(0, limit);
}

export function forgetNote(ctx: Ctx, app: AppRow, id: number, actor: string): { forgotten: number } {
  if (!Number(ctx.store.run('DELETE FROM app_notes WHERE app_id = ? AND id = ?', app.id, id).changes)) {
    throw fail('not_found', `no note ${id} on this App`, '`boxlite-app app recall` lists them with their ids');
  }
  ctx.store.recordActivity(app.id, null, actor, 'note.forget', { id });
  return { forgotten: id };
}
