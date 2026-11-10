# Desktop left navigation

## Outcome and constraints

Feature navigation moves from the top bar to a full-height left sidebar: 64px compact,
224px expanded, with locally persisted expansion. Brand is inside the sidebar:
icon only when compact, full wordmark when expanded. Right column contains the 48px
application header and route content. API Keys and account are separated by 32px.
Keep neutral near-black surfaces, thin icons, no bright selection bar, no horizontal
overflow and no workspace concept. Preserve existing routes and account behavior.

## Related work and choice

| Method | Evidence and trade-off | Decision |
| --- | --- | --- |
| Narrow rail and independent content | [CRM AppIconRail](https://github.com/Mandalorian-Wang/crm/blob/c9473b82e3b4bfd5d0598bbdf7c1f36f3d2d68f0/apps/app/components/app-icon-rail.tsx) uses a 56px rail, named links, right-hand tooltips and active-state backgrounds. [Its app layout](https://github.com/Mandalorian-Wang/crm/blob/c9473b82e3b4bfd5d0598bbdf7c1f36f3d2d68f0/apps/app/app/(app)/%5Bslug%5D/layout.tsx) separates navigation from flexible content. Saves table width; labels require hover/focus. | Pick; adapt to 64px with 40px targets and thin BoxLite icons. |
| Wide expandable sidebar | Existing local ui/sidebar supports expansion, mobile sheets and a cookie. [shadcn composition](https://ui.shadcn.com/docs/components/sidebar) separates header, content and footer. Better persistent labels, but takes more width and requires a small persisted expansion state. | Adapt expansion as explicitly requested. Use a single local preference and reuse existing tooltip/dropdown primitives. |
| Keep top feature navigation | Existing Sidebar keeps labels visible but limits room as features grow. | Replaced as requested. |

The [WAI tooltip guidance](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) describes hover/focus and Escape behavior; it is explicitly a work-in-progress pattern, not a normative sidebar prescription. Links retain accessible names independently of tooltips. No copied CRM source or artwork is needed.

## Behavior and composition

Sidebar owns the left navigation and right header/content composition. Dashboard
supplies route content inside its own Suspense boundary, so loading never removes
the navigation. Sidebar height is viewport minus announcement; its sticky top is
announcement height. Right content subtracts both announcement and header. Keep
min-width:0 on the right column. Mobile retains its 60px header and menu; Welcome
retains its simplified header.

Primary navigation: Boxes, Images, Volumes, Domains, Management. Images has its
existing Images/Private registries children. Management is a disclosure, with
Billing and conditional Organization children. In compact mode clicking Management
expands the rail and reveals its children. Entering a management route opens the
group; manual collapse remains possible. Child links carry current-page semantics and 14px thin-line icons: Layers for
Image library, Server for Private registries, CreditCard for Billing and Building2
for Organization. Their 28px inset and 8px icon gap are shared; backgrounds stay
full-width, without a stepped parent/child selection.

The resource/group area scrolls separately. Quickstart is pinned to the footer.
Collapse sits beside the wordmark in both pinned expansion and hover preview;
it is hidden only in the compact rail with no preview. Clicking the compact
logo expands the rail without navigating; toggle focus is retained. API Keys
is in the header. Profile retains organization switching, theme and logout. Selected items use the neutral accent
surface (#1f1f1f dark), against #0a0a0a sidebar, with quieter hover and visible
keyboard focus. Expansion is saved under boxlite-navigation-expanded; unavailable
storage falls back to in-memory interaction. No speculative routes or dependencies.

## Validation and review

The sidebar is a new layout contract replacing top navigation. Tests cover saved
expansion, unavailable storage, exact route boundaries, compact-mode discovery,
manual disclosure collapse, current links, account switching and Quickstart.
Full-revert defect proof is not applicable to these intentional new contracts.

Desktop mock checks at 1440×900 verified the full-height rail, 64px/224px widths,
32px API Keys/profile gap, and unchanged logo geometry. One 43.2px-high logo asset
is clipped to its symbol when compact; expansion reveals the wordmark without
resizing it. At 1280×480, Quickstart remains visible without horizontal overflow.
An announcement offsets rail and header together; dismissal restores their top.

Infrastructure labels the four resource links. Management is a separate disclosure.
Expanded active parents use foreground emphasis; the selected child uses a single
full-width background. No tree lines or nested selection rectangles are used.

Independent design/code review completed. The final UI checks and pagination
contracts are documented in [visual refinement](2026-11-10-desktop-visual-refinement.md).
[Before/after screenshots and reproduction](assets/desktop-left-navigation/README.md)
compare the implementation with main at `6ca4b882`.

The brand-row bottom border continues the header divider across the sidebar.
An expanded Images group owns its background across the link and disclosure
button, so hover and closed-group selection have the same width as child rows.

## Temporary expansion

When compact, a mouse dwelling on the logo for 350ms reveals a 224px overlay.
The layout keeps reserving 64px, so neither the header nor page content moves.
Moving into the menu keeps it open; leaving the sidebar closes it after 150ms.
Keyboard focus inside the overlay keeps it open until focus leaves or Escape
returns focus to the compact logo. Touch does not trigger hover expansion.
Clicking the logo pins the expanded sidebar and persists that choice. Hover alone
never changes the saved preference. Both expanded states show Collapse beside the
logo; in preview it dismisses the overlay without changing the saved preference.
This is a new interaction contract; verify timing, cancellation, keyboard focus,
persistence and unchanged content geometry in tests and the desktop mock preview.

Desktop mock verification at 1440×900 measured the same content x-position
(104px) before and during preview, with the rail reserving 64px and the overlay
measuring 224px. Pinning moved content to 264px. Mouse navigation followed by
leaving dismissed the preview; the top Collapse button and Escape both restored
focus to the compact logo without changing the saved preference. Light and dark
captures are in the screenshot index. Component tests cover these new contracts,
including brief hover cancellation, touch exclusion and keyboard focus retention.
