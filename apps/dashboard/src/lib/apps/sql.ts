/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// What the SQL console needs to know before it sends a query: which statements it holds (to name
// a write in its confirmation) and whether one changes the schema (refused on main, where schema
// changes go through migrations). The control plane checks the same again.

const WRITE = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'comment',
])
const DDL = new Set(['drop', 'alter', 'create', 'truncate', 'grant', 'revoke', 'comment'])

/** First keyword of each statement, uppercase, ignoring comments and string contents. */
export function statementKinds(query: string): string[] {
  const text = query
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
  return text
    .split(';')
    .map((s) => /^\s*(\w+)/.exec(s)?.[1]?.toLowerCase())
    .filter((k): k is string => !!k)
    .map((k) => k.toUpperCase())
}

export const isWriteKind = (kind: string) => WRITE.has(kind.toLowerCase())
export const isDdlKind = (kind: string) => DDL.has(kind.toLowerCase())

/** 1-based line and column of a Postgres error `position` (a 1-based character offset). */
export function lineAndColumn(query: string, position: number): { line: number; column: number } {
  const before = query.slice(0, Math.max(0, position - 1)).split('\n')
  return { line: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 }
}

/** The next migration file name after the applied ones: 0002_<name>.sql. */
export function nextMigrationFile(applied: string[], name = 'change'): string {
  const last = Math.max(0, ...applied.map((f) => Number(/^(\d+)_/.exec(f)?.[1] ?? 0)))
  return `${String(last + 1).padStart(4, '0')}_${name}.sql`
}

const historyKey = (app: string, env: string) => `boxlite.sql-history.${app}.${env}`

export function loadHistory(app: string, env: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(historyKey(app, env))
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string').slice(0, 10) : []
  } catch {
    return []
  }
}

export function saveHistory(app: string, env: string, list: string[]): void {
  try {
    globalThis.localStorage?.setItem(historyKey(app, env), JSON.stringify(list.slice(0, 10)))
  } catch {
    // Private mode or a full store: history is a convenience.
  }
}
