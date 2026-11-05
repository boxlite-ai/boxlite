## TL;DR

Dashboard pages now share Images' full-width layout, with matching horizontal edges from phone to wide desktop viewports.

## Contract and design

The maintained layout contract lives in the [dashboard README](../../../apps/dashboard/README.md#page-width-and-alignment).
The design and alternatives are recorded in [issue #2347](https://github.com/boxlite-ai/boxlite/issues/2347).

## Before and after

Both screenshots use the SDK/CLI Quickstart, mock data, the light theme, and a
1920 × 1080 CSS-pixel viewport. The baseline is commit `3f8e7d2d`, with none
of this fix's production changes. The deployment cards are 1080px wide.
With the complete fix, they span the shared 1829px content area.

### Before

![Quickstart with a centered outer container and narrow inner panels](2026-11-05-dashboard-page-width/quickstart-before.png)

### After

![Quickstart filling the available page width with shared side padding](2026-11-05-dashboard-page-width/quickstart-after.png)

## Browser measurements

Images, Billing, and Quickstart share the following horizontal content edges.
The browser reserves an 11px scrollbar gutter. All dimensions are CSS pixels.

| Viewport | Left edge | Right edge | Content width |
| --- | --- | --- | --- |
| 2940 | 40 | 2889 | 2849 |
| 1920 | 40 | 1869 | 1829 |
| 1440 | 40 | 1389 | 1349 |
| 1024 | 40 | 973 | 933 |
| 768 | 24 | 733 | 709 |
| 390 | 16 | 363 | 347 |

No tested viewport has page-level horizontal overflow. At 1920px, Boxes,
Volumes, API Keys, Domains, organization settings, image details, and plan
changes also share the same edges. Quickstart's SDK, console, and prompt
panels retain the same width when switching methods.

To inspect the behavior, run `npm run start:mock` from `apps/`, navigate between
`/dashboard/images`, `/dashboard/billing`, and `/dashboard/quickstart`, and
resize through the widths above. Switch all three Quickstart methods and
confirm that the outer edges remain fixed. Inputs and explanatory paragraphs
can remain narrower inside the shared page width.

### Repeatable browser assertion

On each route above, run this in the browser console after the page has loaded.
Repeat at 390px and 1920px, and after opening and closing the profile menu.
It checks rendered widths and computed padding against the public layout contract;
the component tests alone cannot check CSS geometry.

```js
(() => {
  const padding = innerWidth >= 1024 ? 40 : innerWidth >= 640 ? 24 : 16;
  const available = document.documentElement.getBoundingClientRect().width;
  const containers = [...document.querySelectorAll('.page-container')];
  if (!containers.length) throw new Error('No dashboard page container found');
  return containers.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const leftPadding = parseFloat(style.paddingLeft);
    const rightPadding = parseFloat(style.paddingRight);
    if (Math.abs(rect.width - available) > 1 ||
        leftPadding !== padding || rightPadding !== padding) {
      throw new Error('Dashboard width or padding changed');
    }
    return { left: rect.left + leftPadding, right: rect.right - rightPadding };
  });
})();
```

### Scroll-lock regression

At 1920 × 600, Billing has a vertical scrollbar. Before the review fix, opening
the profile menu changed its content right edge from 1869px to 1858px: Radix's
scroll lock added an 11px body margin on top of the stable gutter. After the fix,
opening and closing the menu retains the 1869px edge.

The override is guarded by `@supports (scrollbar-gutter: stable)`, so browsers
without support retain the library's compensation. Stable gutters remain
reserved with hidden overflow, as specified in
[CSS Overflow §4.2](https://www.w3.org/TR/css-overflow-3/#scrollbar-gutter-property).

## Automated checks

`make test:apps:dashboard`, `make build:apps:dashboard` (including TypeScript),
and `make lint:apps` passed. The existing Billing tests retain their containment
assertions and locate the shared page container.
Page layout integration tests exercise the real notification provider and banner
with and without the page container, verifying that actions and dismissal remain
usable. These interaction checks supplement the browser width measurements above;
they do not measure CSS geometry.

`make fmt:check:apps` reports the same 207 existing formatting failures on
the unchanged baseline and the layout branch. Its output is identical;
these files are outside this change. Changed dashboard files are formatted
separately with `make fmt:apps FILES=...`.
