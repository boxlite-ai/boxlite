/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/*
 * Guards the finding-class table in
 * `docs/investigations/box-usage-period-ledger.md` against the SQL it
 * describes, `apps/infra-local/scripts/usage-ledger-audit.sql`.
 *
 * A doc that restates another file's contents drifts from it silently: a class
 * added to the SQL, or a severity changed there, leaves the table quietly
 * wrong. Nothing about that table can be trusted unless something re-reads
 * both — this is that something.
 *
 *   node apps/scripts/usage-period-chaos/check-audit-classes.mjs
 *
 * Exits non-zero on any drift, so it works as a pre-commit or CI check.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SQL = path.join(REPO, 'apps/infra-local/scripts/usage-ledger-audit.sql')
const DOC = path.join(REPO, 'docs/investigations/box-usage-period-ledger.md')

// Every findings branch is `SELECT <severity>, '<CLASS>'`; the first one spells
// out `AS severity` / `AS finding`. No length bound on the class name — a
// bounded one is what hid `GAP` — and `\s` rather than a literal space, so a
// branch wrapped across lines is still seen instead of silently skipped.
const SQL_ROW = /SELECT\s+(\d+)(?:\s+AS\s+severity)?,\s*'([A-Z_]+)'/g
// `| HIGH | 多计费 | `STALE_OPEN` | …`
const DOC_ROW = /^\| (HIGH|MED)\s*\|[^|]*\| `([A-Z_]+)`/gm

// Mirrors `CASE severity WHEN 1 THEN 'HIGH' ELSE 'MED' END` in the SQL, but
// refuses to guess: a severity the SQL grows later must be an error here rather
// than quietly landing in MED, which is the silent-default this check exists to
// stop making.
const SEVERITY_LABELS = { 1: 'HIGH', 2: 'MED' }

const collect = (text, pattern, toEntry) => new Map([...text.matchAll(pattern)].map(toEntry))

const inSql = collect(readFileSync(SQL, 'utf8'), SQL_ROW, (m) => [m[2], m[1]])
const inDoc = collect(readFileSync(DOC, 'utf8'), DOC_ROW, (m) => [m[2], m[1]])

const problems = []
for (const [cls, raw] of inSql) {
  if (!SEVERITY_LABELS[raw]) {
    problems.push(`${cls} has severity ${raw}, which this check does not know how to label — teach it, or fix the SQL`)
  }
  inSql.set(cls, SEVERITY_LABELS[raw] ?? `severity ${raw}`)
}
for (const [cls, severity] of inSql) {
  if (!inDoc.has(cls)) {
    problems.push(`${cls} is emitted by the SQL (${severity}) but missing from the doc table`)
  } else if (inDoc.get(cls) !== severity) {
    problems.push(`${cls} is ${severity} in the SQL but documented as ${inDoc.get(cls)}`)
  }
}
for (const cls of inDoc.keys()) {
  if (!inSql.has(cls)) {
    problems.push(`${cls} is in the doc table but the SQL never emits it`)
  }
}

const counts = [...inSql.values()].reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {})
console.log(
  `usage-ledger-audit.sql emits ${inSql.size} classes (${counts.HIGH ?? 0} HIGH, ${counts.MED ?? 0} MED); ` +
    `the doc table lists ${inDoc.size}`,
)

if (problems.length > 0) {
  console.error(`\n${problems.length} drift(s):`)
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  process.exit(1)
}
console.log('doc table matches the SQL')
