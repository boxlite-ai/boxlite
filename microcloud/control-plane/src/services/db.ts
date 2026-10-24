/** SQL text the CP builds itself (table browser, counts, reset); user SQL never goes through these. */

/** A Postgres identifier, double-quoted. */
export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** A Postgres string literal, single-quoted (standard_conforming_strings is on). */
export const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The app's own tables: base tables of `public`, by name. */
export const TABLES_QUERY = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";

/** Host, database and user of an env's owner URL, for display; the password never leaves the URL. */
export function dbCoordinates(url: string): { host: string; database: string; user: string } {
  const u = new URL(url);
  return { host: u.hostname, database: u.pathname.slice(1), user: decodeURIComponent(u.username) };
}
