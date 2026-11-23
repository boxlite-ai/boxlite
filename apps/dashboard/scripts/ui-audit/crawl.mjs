/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Crawl the mock preview and write one probe report + screenshot per UI state.
// Usage: node crawl.mjs [route-filter|all] [phases] ; output goes to UI_AUDIT_OUT (default ./out).
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { launch, sleep } from './cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.env.UI_AUDIT_OUT || path.join(HERE, 'out')
mkdirSync(OUT, { recursive: true })
const LOG = path.join(OUT, '_progress.log')
const PROBE = readFileSync(path.join(HERE, 'probe.js'), 'utf8')
// axe-core supplies the WCAG contrast and target-size verdicts; the probe covers what axe does not measure.
const AXE_PATH = process.env.AXE_PATH || createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const AXE_SOURCE = readFileSync(AXE_PATH, 'utf8')
const AXE_RUN = `(async () => {
  const res = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] }, resultTypes: ['violations', 'incomplete'] });
  const pack = (list) => list.flatMap((rule) => rule.nodes.map((n) => ({ rule: rule.id, target: String(n.target[0]).slice(0, 160), html: n.html.slice(0, 160), msg: (n.any[0] || n.all[0] || n.none[0] || {}).message || '' })));
  return { violations: pack(res.violations), incomplete: pack(res.incomplete) };
})()`
const BASE = process.env.UI_AUDIT_BASE || 'http://localhost:3000'
const only = process.argv[2] // optional route filter (substring)
const phases = (process.argv[3] || 'base,tabs,focus,variants,overlays,empty').split(',')

const ROUTES = [
  ['boxes', '/dashboard/boxes'],
  ['box-running', '/dashboard/boxes/mock-box-running'],
  ['box-stopped', '/dashboard/boxes/mock-box-stopped'],
  ['box-error', '/dashboard/boxes/mock-box-error'],
  ['box-pulling', '/dashboard/boxes/mock-box-pulling'],
  ['box-terminal', '/dashboard/boxes/mock-box-running/terminal'],
  ['images', '/dashboard/images'],
  ['image-curated', '/dashboard/images/python'],
  ['image-custom', '/dashboard/images/img-python'],
  ['registries', '/dashboard/images/registries'],
  ['volumes', '/dashboard/volumes'],
  ['checkpoints', '/dashboard/checkpoints'],
  ['domains', '/dashboard/domains'],
  ['ci-runners', '/dashboard/ci'],
  ['ci-connects', '/dashboard/ci/connects'],
  ['keys', '/dashboard/keys'],
  ['billing', '/dashboard/billing'],
  ['billing-plan', '/dashboard/billing/plan/max'],
  ['org-settings', '/dashboard/settings'],
  ['org-members', '/dashboard/settings?tab=member'],
  ['quickstart', '/dashboard/quickstart'],
  ['welcome', '/dashboard/welcome'],
  ['landing', '/'],
  ['not-found', '/dashboard/nope'],
  ['ci-callback', '/settings/ci/callback'],
]
const EMPTY_ROUTES = [
  'boxes',
  'images',
  'registries',
  'volumes',
  'domains',
  'billing',
  'checkpoints',
  'ci-runners',
  'ci-connects',
]

const log = (s) => {
  appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${s}\n`)
}

const page = await launch({ profileDir: path.join(OUT, '.chrome-profile') })

async function setStorage(kv) {
  await page.eval(
    `(() => { const kv = ${JSON.stringify(kv)}; for (const k in kv) { if (kv[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, kv[k]); } return true })()`,
  )
}
async function settle() {
  await sleep(700)
  for (let i = 0; i < 25; i += 1) {
    const busy = await page.eval(
      `(() => { const sk = [...document.querySelectorAll('[class*="skeleton" i],[class*="animate-pulse"],[aria-busy="true"]')].some(e => e.checkVisibility()); const ready = !!document.querySelector('main, h1, [role=dialog], button'); return sk || !ready })()`,
    )
    if (!busy) break
    await sleep(300)
  }
  await sleep(500)
}
async function open(url) {
  await page.goto(BASE + url)
  await settle()
}
async function record(name, { full = true } = {}) {
  try {
    const report = await page.eval(PROBE)
    if (!(await page.eval('typeof window.axe === "object"'))) await page.eval(AXE_SOURCE + '; true')
    report.axe = await page.eval(AXE_RUN)
    report.state = name
    report.viewport = await page.eval('`${innerWidth}x${innerHeight}`')
    writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(report))
    await page.shot(path.join(OUT, `${name}.png`), { full })
    log(`ok ${name} findings=${report.f.length}`)
  } catch (e) {
    log(`ERR ${name} ${String(e).slice(0, 200)}`)
  }
}
const overlayOpen = () =>
  page.eval(
    `(() => { const o = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]')].filter(e => e.checkVisibility()); return o.length ? (o[o.length-1].getAttribute('role') || 'popper') : '' })()`,
  )

async function dismiss(url) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await overlayOpen())) break
    await page.key('Escape', 'Escape', 27)
    await sleep(350)
  }
  const here = await page.eval('location.pathname + location.search')
  if ((await overlayOpen()) || here !== url) await open(url)
}

const TRIGGERS = `(() => {
  const seen = new Set(); const res = [];
  const scope = [...document.querySelectorAll('button, [role=button], [role=combobox]')];
  for (const el of scope) {
    if (!el.checkVisibility() || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[class*="tsqd-"]') || el.getBoundingClientRect().left < 60 || /navigation|onboarding guide/i.test(el.getAttribute('aria-label') || '')) continue;
    if (el.getAttribute('role') === 'tab' || el.closest('[role=tablist]')) continue;
    const label = ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.title || 'icon').replace(/\\s+/g, ' ').slice(0, 40);
    if (/sign out|log out/i.test(label)) continue;
    const key = ((el.innerText || '').trim() ? label.replace(/\\S*\\d\\S*/g, '#') : label.split(' ')[0]) + '|' + (el.className + '').slice(0, 60);
    if (seen.has(key)) continue; seen.add(key);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    res.push({ label, x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  return res;
})()`
const locate = (label) => `(() => {
  const want = ${JSON.stringify(label)};
  const el = [...document.querySelectorAll('button, [role=button], [role=combobox]')].find(e => e.checkVisibility() && !e.closest('[class*="tsqd-"]') && e.getBoundingClientRect().left >= 60 && (((e.innerText || '').trim() || e.getAttribute('aria-label') || e.title || 'icon').replace(/\\s+/g, ' ').slice(0, 40)) === want);
  if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`
const MENU_ITEMS = `(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].filter(e => e.checkVisibility() && !e.closest('a') && e.tagName !== 'A' && !/sign out|docs|discord/i.test(e.innerText)).map(e => { const r = e.getBoundingClientRect(); return { label: e.innerText.trim().slice(0, 30), x: r.left + r.width / 2, y: r.top + r.height / 2 } }))()`
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28) || 'x'

async function overlays(name, url) {
  const triggers = await page.eval(TRIGGERS)
  log(`triggers ${name}: ${triggers.map((t) => t.label).join(' | ')}`)
  for (const t of triggers.slice(0, 18)) {
    const at = await page.eval(locate(t.label))
    if (!at) continue
    await page.click(at.x, at.y)
    await sleep(700)
    const kind = await overlayOpen()
    const here = await page.eval('location.pathname + location.search')
    if (!kind) {
      if (here !== url) log(`nav ${name} "${t.label}" -> ${here}`)
      const toast = await page.eval(`!!document.querySelector('[data-sonner-toast]')`)
      if (toast) await record(`${name}~toast-${slug(t.label)}`, { full: false })
      if (here !== url || toast) await open(url)
      continue
    }
    await record(`${name}~${kind}-${slug(t.label)}`, { full: false })
    if (kind === 'menu') {
      const items = await page.eval(MENU_ITEMS)
      for (const it of items.slice(0, 5)) {
        await dismiss(url)
        const again = await page.eval(locate(t.label))
        if (!again) break
        await page.click(again.x, again.y)
        await sleep(500)
        const pos = (await page.eval(MENU_ITEMS)).find((m) => m.label === it.label)
        if (!pos) continue
        await page.click(pos.x, pos.y)
        await sleep(700)
        const k2 = await overlayOpen()
        if (k2 && k2 !== 'menu') await record(`${name}~${k2}-${slug(t.label)}-${slug(it.label)}`, { full: false })
      }
    }
    await dismiss(url)
  }
}

async function tabs(name, url) {
  const labels = await page.eval(
    `[...document.querySelectorAll('[role=tab]')].filter(e => e.checkVisibility() && e.getAttribute('aria-selected') !== 'true').map(e => e.innerText.trim()).slice(0, 8)`,
  )
  for (const label of labels) {
    const pos = await page.eval(
      `(() => { const e = [...document.querySelectorAll('[role=tab]')].find(e => e.checkVisibility() && e.innerText.trim() === ${JSON.stringify(label)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
    )
    if (!pos) continue
    await page.click(pos.x, pos.y)
    await settle()
    await page.eval('window.scrollTo(0,0)')
    await record(`${name}+tab-${slug(label)}`)
  }
  if (labels.length) await open(url)
}

async function focusWalk(name) {
  await page.eval(
    `(() => { window.__sig = (el) => { const c = getComputedStyle(el); return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.backgroundColor, c.textDecorationLine, c.color].join('|') }; for (const el of document.querySelectorAll('*')) el.__before = window.__sig(el); document.activeElement && document.activeElement.blur(); return 1 })()`,
  )
  const rows = []
  for (let i = 0; i < 45; i += 1) {
    await page.key('Tab', 'Tab', 9)
    await sleep(220)
    const r = await page.eval(
      `(() => { const a = document.activeElement; if (!a || a === document.body) return null; const changed = [a, a.parentElement, a.firstElementChild].filter(Boolean).some(e => e.__before !== undefined && window.__sig(e) !== e.__before); const c = getComputedStyle(a); const b = a.getBoundingClientRect(); return { name: ((a.innerText || '').trim() || a.getAttribute('aria-label') || a.placeholder || a.title || a.tagName).replace(/\\s+/g, ' ').slice(0, 30), tag: a.tagName.toLowerCase(), changed, outline: c.outlineStyle + ' ' + c.outlineWidth + ' ' + c.outlineColor + ' off ' + c.outlineOffset, shadow: c.boxShadow.slice(0, 70), x: Math.round(b.left), y: Math.round(b.top), inView: b.top >= 0 && b.bottom <= innerHeight, cls: (a.className + '').slice(0, 90) } })()`,
    )
    if (!r) break
    rows.push(r)
  }
  writeFileSync(path.join(OUT, `${name}@focus.json`), JSON.stringify(rows))
  log(`focus ${name} stops=${rows.length} invisible=${rows.filter((r) => !r.changed).length}`)
}

try {
  await page.viewport(1440, 900)
  await page.goto(`${BASE}/`)
  await sleep(2500)
  const baseStore = {
    'boxlite-theme': 'dark',
    'boxlite-navigation-expanded': 'false',
    'SkipOnboarding_mock-user-00000000': 'true',
    'desktop-review-empty': '0',
    'desktop-review-empty-members': '0',
  }
  await setStorage(baseStore)
  const routes = ROUTES.filter(([n]) => !only || only === 'all' || n.includes(only))
  for (const [name, url] of routes) {
    await page.viewport(1440, 900)
    await setStorage(baseStore)
    await open(url)
    const landed = await page.eval('location.pathname + location.search')
    if (landed !== url) log(`redirect ${name} ${url} -> ${landed}`)
    if (phases.includes('base')) await record(name)
    if (phases.includes('tabs')) await tabs(name, landed)
    if (phases.includes('focus')) {
      await focusWalk(name)
      await open(url)
    }
    if (phases.includes('overlays')) await overlays(name, landed)
    if (phases.includes('variants')) {
      await setStorage({ 'boxlite-theme': 'light' })
      await open(url)
      await record(`${name}@light`)
      await setStorage({ 'boxlite-theme': 'dark', 'boxlite-navigation-expanded': 'true' })
      await open(url)
      await record(`${name}@expanded`)
      await setStorage({ 'boxlite-navigation-expanded': 'false' })
      for (const [w, h] of [
        [1024, 768],
        [768, 1024],
        [390, 844],
        [320, 720],
      ]) {
        await page.viewport(w, h)
        await open(url)
        await record(`${name}@${w}`)
      }
      await page.viewport(1440, 900)
    }
    if (phases.includes('empty') && EMPTY_ROUTES.includes(name)) {
      await setStorage({ 'desktop-review-empty': '1' })
      await open(url)
      await record(`${name}@empty`)
      await tabs(`${name}@empty`, landed)
      await setStorage({ 'desktop-review-empty': '0' })
    }
  }
  writeFileSync(path.join(OUT, '_console.json'), JSON.stringify([...new Set(page.consoleErrors)], null, 1))
  log('DONE')
} catch (e) {
  log(`FATAL ${e.stack}`)
} finally {
  await page.close()
}
