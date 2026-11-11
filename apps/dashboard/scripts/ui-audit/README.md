# UI audit crawl

A manual check that measures the console as rendered. It drives headless Chrome over the DevTools
Protocol against the mock preview, so it needs no backend and no login.

## What it measures

```
 crawl.mjs ──► for each route × theme × width × overlay
                 │
                 ├─ axe-core in the page ──► color-contrast, target-size   (WCAG verdicts)
                 └─ probe.js in the page ──► font sizes off the type scale
                                             elements on fractional pixels
                                             sideways page scroll
                                             stacked 1px edges
                                             clipped text, rounded corners, resting shadows
```

| Measure | Rule |
| --- | --- |
| Contrast, target size | axe-core rules `color-contrast` and `target-size`, run in the page |
| Sideways scroll (`page-hscroll`) | The document is wider than the viewport |
| Fractional pixel (`subpixel`) | An element starts more than 0.1px off a whole pixel and its parent does not |
| Font size (`font-off-scale`) | A computed font size is not 10, 12, 13, 15, 20 or 28px |
| Stacked edge (`double-edge`) | Two parallel border, ring or outline lines from different elements sit 0.45 to 2px apart |

axe-core marks a result "incomplete" when it cannot decide, for example when backgrounds overlap.
Settle those with the probe's `contrast` findings, which composite the text colour over the
ancestor backgrounds.

## Run it

1. Start the mock preview from `apps/`: `npm run start:mock` (serves on `http://localhost:3000`).
2. Crawl. Chrome is found from `CHROME_BIN`, then the usual install paths.

```sh
cd apps/dashboard/scripts/ui-audit
UI_AUDIT_OUT=/tmp/ui-audit node crawl.mjs all          # every route, about 15 minutes
UI_AUDIT_OUT=/tmp/ui-audit node crawl.mjs volumes base # one route, base state only
```

3. Read the results.

```sh
UI_AUDIT_OUT=/tmp/ui-audit node report.mjs axe                  # axe-core violations and incomplete results
UI_AUDIT_OUT=/tmp/ui-audit node report.mjs c . 'page-hscroll'   # one probe kind, one line per element
UI_AUDIT_OUT=/tmp/ui-audit node report.mjs kinds                # finding counts per state
```

Each state also gets a screenshot next to its JSON report.

## States

`crawl.mjs [route-filter|all] [phases]`. Phases default to all of:

| Phase | States |
| --- | --- |
| `base` | Each route at 1440×900, dark theme |
| `tabs` | Each unselected tab on the page |
| `focus` | A keyboard Tab walk; records whether each stop shows a focus indicator |
| `overlays` | Each dialog, menu and toast opened by a distinct button |
| `variants` | Light theme, expanded sidebar, and widths 1024, 768, 390 and 320 |
| `empty` | The mock's empty fixtures, on list routes |

Add a route to `ROUTES` in `crawl.mjs` when a page is added.

## Limits

- It is not part of `make test`: it needs a local Chrome and a running preview.
- It sees only what the mock preview serves. Admin-only pages are not covered.
- Borders drawn with pseudo-elements are invisible to the stacked-edge check.
