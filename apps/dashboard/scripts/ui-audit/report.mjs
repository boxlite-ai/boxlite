/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Summarise probe reports. Usage: node report.mjs <mode> [stateFilterRegex] [kindFilterRegex] [maxPerKind]
//   mode "kinds": counts per kind per state; "list": findings; "inv": inventories; "agg": dedupe across states
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.env.UI_AUDIT_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
const [mode = 'kinds', stateRe = '.', kindRe = '.', max = '40'] = process.argv.slice(2)
const files = readdirSync(OUT).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.includes('@focus'))
const reports = files
  .map((f) => JSON.parse(readFileSync(path.join(OUT, f), 'utf8')))
  .filter((r) => new RegExp(stateRe).test(r.state))
const kre = new RegExp(kindRe)
// strip coordinates so the same element on different pages dedupes
const norm = (s) =>
  s
    .replace(/@-?\d+,-?\d+ \d+x\d+/g, '')
    .replace(/\d+(\.\d+)?px of \d+(\.\d+)?px/g, 'Npx')
    .slice(0, 260)

if (mode === 'axe') {
  // axe-core verdicts: one line per (rule, element), with the states it appears in
  for (const bucket of ['violations', 'incomplete']) {
    const m = new Map()
    for (const r of reports) {
      for (const n of (r.axe && r.axe[bucket]) || []) {
        if (!kre.test(n.rule)) continue
        const key = `${n.rule}§${n.html.replace(/\s+/g, ' ').slice(0, 110)}§${n.msg.slice(0, 120)}`
        const e = m.get(key) || { n: 0, pages: new Set(), node: n }
        e.n += 1
        e.pages.add(r.state.split(/[~+]/)[0])
        m.set(key, e)
      }
    }
    const rows = [...m.values()].sort((a, b) => b.pages.size - a.pages.size)
    const total = rows.reduce((sum, e) => sum + e.n, 0)
    console.log(`\n##### axe ${bucket}: ${rows.length} distinct, ${total} total`)
    for (const e of rows.slice(0, +max)) {
      const pg = [...e.pages]
      console.log(
        `${e.n}x [${e.node.rule}] ${e.node.msg.slice(0, 110)} | ${e.node.html.replace(/\s+/g, ' ').slice(0, 100)} | ${pg.slice(0, 4).join(',')}${pg.length > 4 ? `+${pg.length - 4}` : ''}`,
      )
    }
  }
} else if (mode === 'c') {
  // compact: one line per (kind, description, element class), text ignored
  const m = new Map()
  for (const r of reports) {
    const pageName = r.state.split(/[~@+]/)[0]
    for (const f of r.f.filter((x) => kre.test(x.k))) {
      const cls = (f.el.split(' .')[1] || '').slice(0, 70)
      const tag = (f.el.match(/^<[^>]+>/) || [''])[0]
      const d = f.d
        .replace(/\(-?\d+(\.\d+)?, -?\d+(\.\d+)?\)/g, '')
        .replace(/\d+px of \d+px/g, '')
        .replace(/"[^"]*"@?[\d.]*/g, '""')
        .replace(/@-?\d+,-?\d+ \d+x\d+/g, '')
        .replace(/over \d+px/, '')
        .slice(0, 150)
      const key = `${f.k}§${d}§${tag}§${cls}`
      const e = m.get(key) || {
        n: 0,
        pages: new Set(),
        sample: (f.el.match(/"([^"]*)"/) || [0, ''])[1],
        k: f.k,
        d,
        tag,
        cls,
      }
      e.n += 1
      e.pages.add(pageName)
      m.set(key, e)
    }
  }
  const rows = [...m.values()].sort((a, b) =>
    a.k === b.k ? b.pages.size - a.pages.size || b.n - a.n : a.k < b.k ? -1 : 1,
  )
  let last = ''
  let shown = 0
  for (const e of rows) {
    if (e.k !== last) {
      last = e.k
      shown = 0
      console.log(`\n##### ${last} (${rows.filter((x) => x.k === last).length})`)
    }
    shown += 1
    if (shown > +max) continue
    const pg = [...e.pages]
    console.log(
      `${e.n}× ${e.d} | ${e.tag} "${e.sample.slice(0, 26)}" .${e.cls} | ${pg.slice(0, 4).join(',')}${pg.length > 4 ? `+${pg.length - 4}` : ''}`,
    )
  }
} else if (mode === 'kinds') {
  for (const r of reports) {
    const c = {}
    for (const f of r.f) c[f.k] = (c[f.k] || 0) + 1
    console.log(
      `${r.state} [${r.viewport}] ${Object.entries(c)
        .map(([k, n]) => `${k}:${n}`)
        .join(' ')}`,
    )
  }
} else if (mode === 'list') {
  for (const r of reports) {
    console.log(`\n=== ${r.state} [${r.viewport}]`)
    const per = {}
    for (const f of r.f.filter((x) => kre.test(x.k))) {
      per[f.k] = (per[f.k] || 0) + 1
      if (per[f.k] <= +max) console.log(`[${f.k}] ${f.d}\n      ${f.el.slice(0, 230)}`)
    }
  }
} else if (mode === 'inv') {
  for (const r of reports) {
    console.log(`\n=== ${r.state} [${r.viewport}] title="${r.inv.title}"`)
    for (const k of Object.keys(r.inv)) {
      if (!kre.test(k) || k === 'title') continue
      const v = r.inv[k]
      console.log(
        `-- ${k}: ${Array.isArray(v) ? `\n   ${v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n   ')}` : v}`,
      )
    }
  }
} else if (mode === 'agg') {
  const m = new Map()
  for (const r of reports) {
    for (const f of r.f.filter((x) => kre.test(x.k))) {
      const key = `${f.k}§${norm(f.d)}§${norm(f.el)}`
      const e = m.get(key) || { n: 0, states: new Set(), f }
      e.n += 1
      e.states.add(r.state)
      m.set(key, e)
    }
  }
  const rows = [...m.values()].sort((a, b) => (a.f.k < b.f.k ? -1 : a.f.k > b.f.k ? 1 : b.states.size - a.states.size))
  let last = ''
  let shown = 0
  for (const e of rows) {
    if (e.f.k !== last) {
      last = e.f.k
      shown = 0
      console.log(`\n##### ${last} (${rows.filter((x) => x.f.k === last).length} distinct)`)
    }
    shown += 1
    if (shown > +max) continue
    const st = [...e.states]
    console.log(
      `- ${e.f.d}\n    ${norm(e.f.el).slice(0, 200)}\n    in ${st.length}: ${st.slice(0, 6).join(', ')}${st.length > 6 ? '…' : ''}`,
    )
  }
}
