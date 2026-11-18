/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// In-page detail probe. The crawl evaluates this file as one expression in each UI state and
// stores the returned report. It only reads computed styles and boxes; it changes nothing.
;(() => {
  const SCALE = new Set([10, 12, 13, 15, 20, 28])
  const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p
  const out = { f: [], inv: {} }
  const add = (k, el, d, extra) => out.f.push({ k, el: el ? desc(el) : '', d, ...(extra || {}) })

  const overlayRoot = (el) =>
    el.closest(
      '[role=dialog],[role=menu],[role=listbox],[role=tooltip],[data-radix-popper-content-wrapper],[data-sonner-toaster]',
    )
  const topOverlay = [
    ...document.querySelectorAll('[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]'),
  ].pop()
  const inScope = (el) => (topOverlay ? topOverlay.contains(el) || el.contains(topOverlay) : true)

  function text(el) {
    return (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48)
  }
  function desc(el) {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    const slot = el.getAttribute('data-slot')
    const r = el.getBoundingClientRect()
    const cls = (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').slice(0, 110)
    return `<${tag}${role ? ` role=${role}` : ''}${slot ? ` slot=${slot}` : ''}> "${text(el)}" @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} .${cls}`
  }
  function visible(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    const r = el.getBoundingClientRect()
    if (r.width < 0.5 || r.height < 0.5) return false
    // clipped away by an overflow ancestor
    let p = el.parentElement
    while (p && p !== document.body) {
      const cs = getComputedStyle(p)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect()
        if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return false
      }
      p = p.parentElement
    }
    return true
  }
  function rgba(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '')
    if (!m) return null
    const p = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  function over(top, bottom) {
    const a = top.a
    return {
      r: top.r * a + bottom.r * (1 - a),
      g: top.g * a + bottom.g * (1 - a),
      b: top.b * a + bottom.b * (1 - a),
      a: 1,
    }
  }
  function bgOf(el) {
    const stack = []
    let n = el
    while (n && n.nodeType === 1) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) {
        stack.push(c)
        if (c.a >= 1) break
      }
      n = n.parentElement
    }
    let base = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base)
    return base
  }
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  const isDisabled = (el) => !!el.closest('[disabled],[aria-disabled=true],[data-disabled]')

  const DEV = '.tsqd-parent-container, [class*="tsqd-"], [data-sonner-toaster]'
  const all = [...document.body.querySelectorAll('*')].filter(
    (el) => !el.closest(DEV) && !el.ownerSVGElement && !el.classList.contains('sr-only') && inScope(el) && visible(el),
  )
  const main = document.querySelector('main') || document.body
  const navLink = document.querySelector('a[href$="/dashboard/boxes"]')
  let sideW = 0
  for (let p = navLink; p && p !== document.body; p = p.parentElement) {
    const r = p.getBoundingClientRect()
    if (r.height >= innerHeight - 80 && r.width < 320) sideW = r.right
  }
  const inContent = (el) => el.getBoundingClientRect().left >= sideW - 0.5 && el.getBoundingClientRect().top >= 48
  out.inv.sidebarWidth = sideW

  // ── page-level ────────────────────────────────────────────────────────────
  out.inv.title = document.title
  out.inv.url = location.pathname + location.search
  out.inv.lang = document.documentElement.lang
  if (document.documentElement.scrollWidth > innerWidth + 1) {
    add('page-hscroll', null, `document scrollWidth ${document.documentElement.scrollWidth} > viewport ${innerWidth}`)
  }
  const pageScrolls = document.scrollingElement.scrollHeight > innerHeight + 1
  for (const el of all) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.right > innerWidth + 1 && r.width > 4 && !overlayRoot(el)) {
      // only report the outermost offender
      const pr = el.parentElement?.getBoundingClientRect()
      if (!pr || pr.right <= innerWidth + 1)
        add('overflow-right', el, `right edge ${Math.round(r.right)} past viewport ${innerWidth}`)
    }
    if (
      /(auto|scroll)/.test(cs.overflowY) &&
      el.scrollHeight > el.clientHeight + 1 &&
      el !== document.scrollingElement
    ) {
      const parentScroller = (() => {
        let p = el.parentElement
        while (p) {
          const pc = getComputedStyle(p)
          if (/(auto|scroll)/.test(pc.overflowY) && p.scrollHeight > p.clientHeight + 1) return p
          p = p.parentElement
        }
        return null
      })()
      add(
        'scroller',
        el,
        `inner vertical scroller ${el.clientHeight}px of ${el.scrollHeight}px${parentScroller || pageScrolls ? ' NESTED inside another scroller' : ''}`,
      )
    }
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      add('hscroller', el, `horizontal scroller ${el.clientWidth}px of ${el.scrollWidth}px`)
    }
  }

  // ── typography ────────────────────────────────────────────────────────────
  const typo = new Map()
  const textEls = []
  for (const el of all) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim())
      .join(' ')
    if (!own) continue
    textEls.push(el)
    const cs = getComputedStyle(el)
    const size = round(parseFloat(cs.fontSize), 2)
    const fam = /mono/i.test(cs.fontFamily.split(',')[0]) ? 'mono' : 'sans'
    const ls = cs.letterSpacing === 'normal' ? '0' : `${round(parseFloat(cs.letterSpacing) / size, 3)}em`
    const key = `${size}px ${cs.fontWeight} ${fam} ls${ls} ${cs.textTransform === 'none' ? '' : cs.textTransform} lh${cs.lineHeight === 'normal' ? 'n' : round(parseFloat(cs.lineHeight) / size, 2)}`
    const e = typo.get(key) || { n: 0, s: [] }
    e.n += 1
    if (e.s.length < 3) e.s.push(own.slice(0, 28))
    typo.set(key, e)
    if (!SCALE.has(size)) add('font-off-scale', el, `${size}px not in type scale (10/12/13/15/20/28)`)

    // contrast
    const fg = rgba(cs.color)
    if (fg) {
      const bg = bgOf(el)
      const eff = over(fg, bg)
      const l1 = lum(eff)
      const l2 = lum(bg)
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
      if (ratio < (large ? 3 : 4.5)) {
        add(
          'contrast',
          el,
          `${round(ratio, 2)}:1 ${hex(eff)} on ${hex(bg)} ${size}px${isDisabled(el) ? ' (disabled)' : ''}`,
        )
      }
    }
    // truncation / wrapping
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') {
      const hasFull = el.title || el.closest('[title]')?.title
      add(
        'truncated',
        el,
        `text clipped (${el.clientWidth}px of ${el.scrollWidth}px)${hasFull ? '' : ' with no title attribute for the full value'}`,
      )
    }
    // copy smells
    if (/\.\.\.$|\.\.\.\s/.test(own))
      add('copy', el, `three dots instead of an ellipsis character: "${own.slice(0, 40)}"`)
    if (/\s{2,}/.test(own.replace(/ /g, ' '))) add('copy', el, `double space: "${own.slice(0, 40)}"`)
    if (/\w'\w/.test(own)) add('copy', el, `straight apostrophe: "${own.slice(0, 40)}"`)
    if (/^\s*[·•|/,]/.test(own) && !el.previousElementSibling && !el.previousSibling)
      add('copy', el, `text starts with a separator: "${own.slice(0, 40)}"`)
  }
  out.inv.typo = [...typo.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${v.n}× ${k} — ${v.s.join(' | ')}`)

  // ── design language: radius and resting shadows ───────────────────────────
  for (const el of all) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const rad = parseFloat(cs.borderTopLeftRadius)
    if (
      rad > 0 &&
      rad < Math.min(r.width, r.height) / 2 - 0.5 &&
      (cs.borderTopWidth !== '0px' || rgba(cs.backgroundColor)?.a > 0)
    ) {
      add('rounded', el, `border-radius ${cs.borderTopLeftRadius} (language is square)`)
    }
    if (
      cs.boxShadow !== 'none' &&
      !/inset/.test(cs.boxShadow) &&
      !overlayRoot(el) &&
      !/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px/.test(cs.boxShadow)
    ) {
      const visibleShadow = cs.boxShadow
        .split(/,(?![^(]*\))/)
        .some((s) => !/rgba\(\d+, \d+, \d+, 0\)/.test(s) && !/0px 0px 0px 0px/.test(s))
      if (visibleShadow) add('resting-shadow', el, `box-shadow ${cs.boxShadow.slice(0, 80)}`)
    }
  }

  // ── stacked edges (double borders) ────────────────────────────────────────
  const H = []
  const V = []
  const lineColor = (c) => {
    const p = rgba(c)
    return p && p.a > 0.08 ? p : null
  }
  all.forEach((el, i) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const push = (arr, pos, a, b, w, why) => arr.push({ pos, a, b, w, i, why })
    const bt = parseFloat(cs.borderTopWidth)
    const bb = parseFloat(cs.borderBottomWidth)
    const bl = parseFloat(cs.borderLeftWidth)
    const br = parseFloat(cs.borderRightWidth)
    if (bt > 0 && cs.borderTopStyle !== 'none' && lineColor(cs.borderTopColor))
      push(H, r.top + bt / 2, r.left, r.right, bt, 'border-top')
    if (bb > 0 && cs.borderBottomStyle !== 'none' && lineColor(cs.borderBottomColor))
      push(H, r.bottom - bb / 2, r.left, r.right, bb, 'border-bottom')
    if (bl > 0 && cs.borderLeftStyle !== 'none' && lineColor(cs.borderLeftColor))
      push(V, r.left + bl / 2, r.top, r.bottom, bl, 'border-left')
    if (br > 0 && cs.borderRightStyle !== 'none' && lineColor(cs.borderRightColor))
      push(V, r.right - br / 2, r.top, r.bottom, br, 'border-right')
    // inset ring: "… 0px 0px 0px 1px inset"
    for (const part of cs.boxShadow === 'none' ? [] : cs.boxShadow.split(/,(?![^(]*\))/)) {
      const m = /(rgba?\([^)]+\))\s+0px 0px 0px (\d+(?:\.\d+)?)px inset/.exec(part.trim())
      if (m && lineColor(m[1])) {
        const w = parseFloat(m[2])
        const o = bt // ring sits inside the border box edge
        push(H, r.top + o + w / 2, r.left, r.right, w, 'inset-ring-top')
        push(H, r.bottom - parseFloat(cs.borderBottomWidth) - w / 2, r.left, r.right, w, 'inset-ring-bottom')
        push(V, r.left + bl + w / 2, r.top, r.bottom, w, 'inset-ring-left')
        push(V, r.right - br - w / 2, r.top, r.bottom, w, 'inset-ring-right')
      }
      const o2 = /(rgba?\([^)]+\))\s+0px 0px 0px (\d+(?:\.\d+)?)px$/.exec(part.trim())
      if (o2 && lineColor(o2[1])) {
        const w = parseFloat(o2[2])
        push(H, r.top - w / 2, r.left, r.right, w, 'ring-top')
        push(H, r.bottom + w / 2, r.left, r.right, w, 'ring-bottom')
        push(V, r.left - w / 2, r.top, r.bottom, w, 'ring-left')
        push(V, r.right + w / 2, r.top, r.bottom, w, 'ring-right')
      }
    }
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && lineColor(cs.outlineColor)) {
      const w = parseFloat(cs.outlineWidth)
      const off = parseFloat(cs.outlineOffset) || 0
      push(H, r.top - off - w / 2, r.left, r.right, w, 'outline-top')
      push(H, r.bottom + off + w / 2, r.left, r.right, w, 'outline-bottom')
      push(V, r.left - off - w / 2, r.top, r.bottom, w, 'outline-left')
      push(V, r.right + off + w / 2, r.top, r.bottom, w, 'outline-right')
    }
    // hairline separators drawn as thin filled boxes
    if (r.height <= 1.5 && r.width > 12 && lineColor(cs.backgroundColor))
      push(H, r.top + r.height / 2, r.left, r.right, r.height, 'hairline')
    if (r.width <= 1.5 && r.height > 12 && lineColor(cs.backgroundColor))
      push(V, r.left + r.width / 2, r.top, r.bottom, r.width, 'hairline')
  })
  const seenPair = new Set()
  const scan = (arr, axis) => {
    arr.sort((x, y) => x.pos - y.pos)
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length && arr[j].pos - arr[i].pos <= 2.01; j += 1) {
        const a = arr[i]
        const b = arr[j]
        if (a.i === b.i) continue
        const gap = b.pos - a.pos
        const overlap = Math.min(a.b, b.b) - Math.max(a.a, b.a)
        if (overlap < 10) continue
        // gap 0 = perfectly coincident lines (drawn once); adjacent lines read as a thick edge
        if (gap < 0.45) continue
        const key = `${a.i}:${b.i}:${axis}`
        if (seenPair.has(key)) continue
        seenPair.add(key)
        out.f.push({
          k: 'double-edge',
          el: desc(all[a.i]),
          d: `${axis} lines ${round(gap)}px apart over ${Math.round(overlap)}px: ${a.why} + ${b.why} of ${desc(all[b.i])}`,
        })
      }
    }
  }
  scan(H, 'horizontal')
  scan(V, 'vertical')

  // ── sub-pixel placement ───────────────────────────────────────────────────
  const frac = (n) => Math.abs(n - Math.round(n))
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (frac(r.left) > 0.1 || frac(r.top) > 0.1) {
      const pr = el.parentElement?.getBoundingClientRect()
      if (pr && frac(pr.left) <= 0.1 && frac(pr.top) <= 0.1) {
        const cs = getComputedStyle(el)
        const bordered = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth) > 0 || el.querySelector('*')
        if (bordered && el.tagName !== 'path')
          add(
            'subpixel',
            el,
            `starts at fractional pixel (${round(r.left, 2)}, ${round(r.top, 2)}) — borders/text blur`,
          )
      }
    }
  }

  // ── controls ──────────────────────────────────────────────────────────────
  const CONTROL =
    'button,a[href],input,select,textarea,[role=button],[role=tab],[role=radio],[role=switch],[role=checkbox],[role=combobox],[role=menuitem],[role=option]'
  const controls = all.filter((el) => el.matches(CONTROL))
  const ctlKinds = new Map()
  for (const el of controls) {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const inline = cs.display === 'inline' && el.tagName === 'A'
    const bare =
      el.matches('input,textarea') &&
      cs.borderTopWidth === '0px' &&
      el.parentElement.getBoundingClientRect().height >= 24
    if (!inline && !bare && (r.width < 24 || r.height < 24) && !el.matches('input[type=checkbox],input[type=radio]')) {
      add('small-target', el, `hit target ${Math.round(r.width)}x${Math.round(r.height)} (< 24px)`)
    }
    const name =
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') &&
        document.getElementById(el.getAttribute('aria-labelledby').split(' ')[0])?.textContent) ||
      el.title ||
      (el.innerText || '').trim() ||
      el.querySelector('img[alt]')?.alt ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
      el.closest('label')?.textContent
    if (!name || !String(name).trim()) {
      add(
        'no-name',
        el,
        el.placeholder ? `no accessible name (placeholder "${el.placeholder}" only)` : 'no accessible name',
      )
    }
    if (
      !(el.innerText || '').trim() &&
      el.matches('button,[role=button],a') &&
      !el.title &&
      !el.getAttribute('aria-describedby') &&
      el.getAttribute('data-slot') !== 'tooltip-trigger' &&
      !el.closest('[data-slot=tooltip-trigger]')
    ) {
      add(
        'icon-only-no-title',
        el,
        `icon-only control with no title (aria-label="${el.getAttribute('aria-label') || ''}")`,
      )
    }
    if (
      !isDisabled(el) &&
      cs.cursor !== 'pointer' &&
      el.matches('button,[role=button],[role=tab],[role=radio],[role=switch],[role=menuitem],a[href]')
    ) {
      add('cursor', el, `interactive but cursor is "${cs.cursor}"`)
    }
    if (isDisabled(el) && cs.cursor === 'pointer') add('cursor', el, 'disabled but cursor is still pointer')
    if (el.matches('button') && !el.getAttribute('type') && el.closest('form'))
      add('button-type', el, 'button inside a form with no type attribute')
    const kind = `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} h${Math.round(r.height)} ${round(parseFloat(cs.fontSize), 1)}px/${cs.fontWeight} pad ${cs.paddingLeft}/${cs.paddingRight} ${cs.textTransform === 'none' ? '' : cs.textTransform} bw${cs.borderTopWidth}`
    const e = ctlKinds.get(kind) || { n: 0, s: [] }
    e.n += 1
    if (e.s.length < 3) e.s.push(text(el).slice(0, 22))
    ctlKinds.set(kind, e)
  }
  out.inv.controls = [...ctlKinds.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `${v.n}× ${k} — ${v.s.join(' | ')}`)

  // rows: sibling control heights and vertical centring
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (!/flex|grid/.test(cs.display)) continue
    if (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) continue
    const kids = [...el.children].filter(visible)
    if (kids.length < 2) continue
    const rects = kids.map((k) => k.getBoundingClientRect())
    const sameRow = rects.every((r) => r.top < rects[0].bottom && r.bottom > rects[0].top)
    if (!sameRow) continue
    const ctl = kids.filter((k) => k.matches(CONTROL) || k.querySelector(':scope > input, :scope > button'))
    if (ctl.length >= 2) {
      const hs = ctl.map((k) => Math.round(k.getBoundingClientRect().height))
      const mn = Math.min(...hs)
      const mx = Math.max(...hs)
      if (mx - mn >= 1 && mx - mn <= 8)
        add(
          'row-heights',
          el,
          `adjacent controls differ in height: ${ctl.map((k, i) => `"${text(k).slice(0, 16)}" ${hs[i]}px`).join(', ')}`,
        )
    }
    const centres = rects.map((r) => r.top + r.height / 2)
    const spread = Math.max(...centres) - Math.min(...centres)
    if (spread >= 1 && spread <= 5 && cs.alignItems !== 'baseline') {
      add(
        'row-centre',
        el,
        `children vertical centres differ by ${round(spread)}px (align-items: ${cs.alignItems}): ${kids
          .map((k, i) => `"${text(k).slice(0, 14)}"@${round(centres[i])}`)
          .slice(0, 5)
          .join(', ')}`,
      )
    }
  }

  // ── left/right edge near-misses inside the content area ───────────────────
  const edgeEls = all.filter(
    (el) =>
      inContent(el) &&
      !overlayRoot(el) &&
      (textEls.includes(el) ||
        el.matches(`${CONTROL},table,svg,img,hr`) ||
        parseFloat(getComputedStyle(el).borderTopWidth) > 0),
  )
  const lefts = new Map()
  const rights = new Map()
  const startX = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    // for text holders, the ink starts after padding
    return textEls.includes(el) && !el.matches(CONTROL)
      ? r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)
      : r.left
  }
  for (const el of edgeEls) {
    const x = Math.round(startX(el) * 2) / 2
    lefts.set(x, (lefts.get(x) || 0) + 1)
    const xr = Math.round(el.getBoundingClientRect().right * 2) / 2
    rights.set(xr, (rights.get(xr) || 0) + 1)
  }
  const dom = (m) => [...m.entries()].filter(([, n]) => n >= 4).map(([x]) => x)
  const domL = dom(lefts)
  const domR = dom(rights)
  out.inv.leftEdges = [...lefts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([x, n]) => `${x}:${n}`)
    .join(' ')
  out.inv.rightEdges = [...rights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([x, n]) => `${x}:${n}`)
    .join(' ')
  for (const el of edgeEls) {
    const x = Math.round(startX(el) * 2) / 2
    if ((lefts.get(x) || 0) <= 2) {
      const near = domL.find((d) => Math.abs(d - x) >= 1 && Math.abs(d - x) <= 6)
      if (near !== undefined)
        add(
          'edge-left',
          el,
          `left edge ${x} is ${round(x - near)}px off the ${near} guide (${lefts.get(near)} elements)`,
        )
    }
    const xr = Math.round(el.getBoundingClientRect().right * 2) / 2
    if ((rights.get(xr) || 0) <= 2) {
      const near = domR.find((d) => Math.abs(d - xr) >= 1 && Math.abs(d - xr) <= 6)
      if (near !== undefined)
        add(
          'edge-right',
          el,
          `right edge ${xr} is ${round(xr - near)}px off the ${near} guide (${rights.get(near)} elements)`,
        )
    }
  }

  // ── tables ────────────────────────────────────────────────────────────────
  out.inv.tables = [...document.querySelectorAll('table,[role=table],[role=grid]')].filter(visible).map((t) => {
    const th = t.querySelector('th,[role=columnheader]')
    const rows = [...t.querySelectorAll('tbody tr,[role=row]')].filter(visible)
    const td = rows[0]?.querySelector('td,[role=cell]')
    const tcs = th ? getComputedStyle(th) : null
    const dcs = td ? getComputedStyle(td) : null
    const hs = [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))]
    return {
      headers: [...t.querySelectorAll('th,[role=columnheader]')].map((h) => h.innerText.trim()).join(' | '),
      th: tcs
        ? `${tcs.fontSize}/${tcs.fontWeight} ${tcs.textTransform} ls${tcs.letterSpacing} pad ${tcs.paddingLeft} h${Math.round(th.getBoundingClientRect().height)} ${/mono/i.test(tcs.fontFamily.split(',')[0]) ? 'mono' : 'sans'}`
        : '',
      td: dcs ? `${dcs.fontSize}/${dcs.fontWeight} pad ${dcs.paddingLeft} ${dcs.paddingTop}` : '',
      rowHeights: hs.join(','),
      rows: rows.length,
    }
  })

  // ── icons ─────────────────────────────────────────────────────────────────
  const icons = new Map()
  for (const s of all.filter((el) => el.tagName === 'svg')) {
    const r = s.getBoundingClientRect()
    const sw = getComputedStyle(s).strokeWidth
    const k = `${Math.round(r.width)}x${Math.round(r.height)} sw${sw}`
    icons.set(k, (icons.get(k) || 0) + 1)
    if (Math.abs(r.width - r.height) > 0.6 && r.width < 40)
      add('icon-not-square', s, `icon box ${round(r.width)}x${round(r.height)}`)
  }
  out.inv.icons = [...icons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${k}`)
    .join(' · ')
  for (const img of all.filter((el) => el.tagName === 'IMG')) {
    if (!img.hasAttribute('alt')) add('img-alt', img, 'image has no alt attribute')
    if (img.naturalWidth && img.naturalWidth < img.width * 0.99)
      add('img-upscaled', img, `image upscaled ${img.naturalWidth}px → ${img.width}px`)
  }

  // ── inventory for copy review ─────────────────────────────────────────────
  const uniq = (a) => [...new Set(a.filter(Boolean))]
  out.inv.headings = uniq(
    all
      .filter((el) => /^H[1-6]$/.test(el.tagName))
      .map(
        (h) =>
          `${h.tagName}:${text(h)} [${getComputedStyle(h).fontSize}/${getComputedStyle(h).fontWeight} @${Math.round(h.getBoundingClientRect().left)},${Math.round(h.getBoundingClientRect().top)}]`,
      ),
  )
  out.inv.buttons = uniq(
    controls
      .filter(
        (el) =>
          el.matches('button,[role=button],a[href]') && (inContent(el) || (topOverlay && topOverlay.contains(el))),
      )
      .map(
        (el) =>
          (el.innerText || '').trim().replace(/\s+/g, ' ') ||
          `[icon:${el.getAttribute('aria-label') || el.title || '?'}]`,
      ),
  )
  out.inv.placeholders = uniq(all.filter((el) => el.placeholder).map((el) => el.placeholder))
  out.inv.tabs = uniq(all.filter((el) => el.matches('[role=tab]')).map(text))
  out.inv.focusables = controls.filter((el) => !isDisabled(el) && el.tabIndex >= 0).length
  return out
})()
