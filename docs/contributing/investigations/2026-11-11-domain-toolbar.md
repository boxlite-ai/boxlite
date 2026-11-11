# Resource list toolbar refinements

## Problem

At exhausted quota, the long warning shares a wrapping flex row with the filter
and Request domain action. On main `1c5ef25b5`, a 1440px desktop viewport places
that action 48px below the filter.

## Layout decision

Keep the existing filter and action sizes. A two-column grid reserves an
intrinsic-width action column; the filter column can shrink and caps the filter
at its available width. Quota usage and conditional guidance span the second row,
including when quota remains. Guidance wraps without displacing the action.
Below the small-screen breakpoint the controls stack. Request eligibility,
permissions, text and API behavior are unchanged. Other resource toolbars are
outside this correction.

## Verification

Start the dashboard's mock preview and open Domains. Request two additional
names to fill the default five-slot quota. At 1440px, measure the filter wrapper
and Request domain button with `getBoundingClientRect()`:

| Production version | Filter top | Button top | Alignment assertion |
| --- | --- | --- | --- |
| Unmodified main | 159.32px | 207.32px | Failed |
| Complete fix | 159.32px | 159.32px | Passed |

The same alignment and document-overflow checks passed at 1280, 1440 and 1920px,
with expanded and collapsed navigation. A temporary mock response with a null
domain suffix also kept the disabled action aligned at 1280px; the fixture was
restored afterward. Domains page tests passed (13 tests), production build passed,
and the changed component passed ESLint.

Workspace-wide `make lint:apps` remains blocked by three existing
`@nx/enforce-module-boundaries` errors on lines 10–12 of
`apps/infra/deployment/release-audit-workflow.test.ts`, unchanged from main.

## Desktop evidence

Before:

![Quota-full toolbar before correction](assets/domain-toolbar/before.png)

After:

![Quota-full toolbar after correction](assets/domain-toolbar/after.png)


## API Keys filter

API Keys previously had a create action without the shared resource filter.
Reuse ResourceFilter on the left and keep Create Key on the right. Name matching
is local, case-insensitive, and trims surrounding whitespace. The matching count
updates with the rows. A filtered-empty result offers Clear filter; genuine empty
organizations retain setup guidance. Masked secrets are not searched, and create
permissions and revoke identity are unchanged.

Before production edits, the real-page filter suite failed three assertions because
the input was absent. The same suite passed after implementation, including
case/whitespace matching, no-match recovery, and revoking the correct filtered key.
Existing create-permission tests also passed. Desktop checks at 1280, 1440 and
1920px confirmed aligned filter/action controls and no horizontal overflow. Mock
checks covered search, opening/canceling revoke confirmation, and clearing no matches.

![API Keys before](assets/api-key-filter/before.png)
![API Keys after](assets/api-key-filter/after.png)

## Compact Boxes overview

Three StatCards made the overview 101px tall, with an additional 24px below.
Only Boxes now uses an inline description list: Total, Running and Stopped with
18px tabular numerals, quiet labels, and horizontal separators. Repeated captions,
dot-matrix numerals and LIVE decoration are removed from this view. Shared
StatCard remains unchanged. The overview still uses independent organization
counts and appears only from ten Boxes onward; it does not summarize the current
filtered page. Unknown counts retain their existing placeholder.

A browser geometry assertion failed before this change at 1440px (101.05px
height). The unchanged assertion passed after: 50px at 1280/1440/1920px, without
horizontal overflow. Including the reduced margin, the toolbar and list move up
59px. Two invariant tests preserve the 9/10 threshold independently of list rows;
these check unchanged behavior, rather than reproducing the height defect.

The combined Domains, Boxes and Keys suites passed 33 tests. Targeted ESLint has
zero errors; five existing non-null-assertion warnings remain in Boxes tests.
Temporary populated mock fixtures were restored after desktop screenshots.

![Boxes overview before](assets/boxes-summary/before.png)
![Boxes overview after](assets/boxes-summary/after.png)
