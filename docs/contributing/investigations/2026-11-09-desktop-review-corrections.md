# Desktop dashboard consistency

## Problem

Resource pages use different title sizes, status treatments, row feedback, empty-state illustrations and creation-dialog layouts. The dark palette has a blue cast, while Quickstart code boundaries disappear against its background. The desktop template picker traps a long catalog in a short nested scroll area and stretches its adjacent form.

Comparison baseline: `a4a7b8296e6920b08c79cab4e257bf28eb6b3fe0` on main.

## Scope

Improve presentation in the existing dashboard without replacing page implementations, changing APIs or removing permission checks. Keep existing feature descriptions and help links, except the redundant Domains footer. Images remains a catalog: remove its independent New box action and preserve creation from individual images.

## Design

| Area | Contract |
| --- | --- |
| Theme | Neutral near-black structural surfaces; retain semantic and brand hues and the light theme. |
| Resources | Shared 28px page titles, 14px names, 12px status labels with semantic marks, consistent row hover and keyboard focus. |
| Empty states | Shared 48px icon tile, 24px pixel glyph, title, description and supplementary guide; one primary action in the toolbar where creation applies. |
| Forms | Shared header, scrollable body and footer; preserve existing fields, validation, submission and permissions. |
| Icons | Pixel glyphs identify resource types; separate status labels convey state. Payment and Quickstart environment brands retain their own artwork. |
| Quickstart | Explicit code-surface border; natural page scrolling for templates; content-sized detail form, sticky only where desktop height permits. |
| Image usage | `Custom images 3 / 20 · Total image size 456 MiB`: independent count quota and aggregate size labels, with quota warnings affecting only the count. |
| Network | Three compact rows; accurate enabled/disabled values, wrapping outbound values and room for switch hit targets. Explain policy only in the enable confirmation. |

`knownBytes` sums declared sizes across ready versions of organization-owned images. It is neither deduplicated physical storage nor a billing measurement. Curated images do not consume the organization's count quota.

Inbound disabled is a proxy gate: `get_box_target.go` and `tunnel.go` reject traffic before tunnel authorization. When enabled, public/private policy applies; private access accepts a valid token or organization authentication. This corrects the former `disabled · your organization` label without changing backend authorization.

## Mechanism and failure handling

`ResourceEmptyState`, `StatusIndicator`, resource CSS classes and form-dialog wrappers centralize presentation while callers retain business decisions. Loading, failed requests, empty successful results and filtered no-results remain distinct. Billing histories and Volumes expose retryable errors instead of showing successful empty states after a request fails.

Mock-only fixtures provide repeatable empty-resource previews. A separate members fixture avoids removing organization permissions while checking other empty pages. Production responses are unchanged.

## Related work and trade-offs

- [Carbon empty states](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states) separates next-step guidance and secondary links. Adapt that distinction to the existing centered resource layout.
- [Payment SVG assets](https://github.com/aaronfagan/svg-credit-card-payment-icons/tree/6dd023ae32415ed7b01bf809f15a25613a52098c) provide bundled brand artwork; retain their Apache-2.0 license and avoid runtime image lookups.
- Reuse the existing pixel icon shim and dialog primitive. Preserve recognizable branding without mixing wireframe and pixel resource icons.
- Keep surface levels and a stronger local code border rather than making every dark surface identical black.

## Validation and evidence

See [desktop screenshots and reproduction](assets/desktop-dashboard-review/README.md) and [dashboard presentation contracts](../../../apps/dashboard/README.md#desktop-review-code-surfaces-payment-identity-and-empty-resources).

Component checks cover creation actions, error-versus-empty results, payment identities, image usage, network labels and dialog behavior. Browser review covers populated and empty desktop pages, both code themes, short-height templates and Box details at 1280/1440/1920 widths. The details column's measured content width changes from 349px to its 340px viewport width.

Proxy tunnel tests and API tunnel-service tests passed locally. The preview-controller suite could not compile because local linked dependencies resolved incompatible Axios types. No deployed authorization, real payment, SSH connection or backend resource mutation is claimed by these mock screenshots.

## Error recovery and constrained-height dialogs

History pagination retains Previous whenever the selected page exceeds one, even if that page's failed request supplies no total. Unknown totals display the current page without inventing a total; Next remains unavailable. Apply this to both invoice and credit histories.

A failed Images refresh keeps useful cached rows and explicitly labels them as previously loaded data; an initial failure without cached rows retains the unavailable message. Unmapped invoice status values remain verbatim, while mapped labels keep the shared display treatment.

Create Box places pricing details and validation errors inside the scrollable form body, with only the header and action footer fixed. Expanding pricing on a short desktop must not collapse the editable area. Component regressions exercise each transition; short-height browser measurements verify the form and footer remain reachable.

## Resource toolbar alignment

Resource list pages share a 24px title-to-toolbar gap, a 36px desktop toolbar, and a 14px toolbar-to-list gap. The Boxes overview remains a separate section for fleets of at least ten Boxes. One consumed filter component owns width (380px), solid border, typography, neutral search icon, count, accessible name, and focus treatment. Boxes, Images, Volumes, Domains, and Private registries use it; registries filter locally by host, repository prefix, or username without changing credentials. Images usage stays in the toolbar on desktop and wraps only when space requires it. Existing feature guidance remains available.

The Boxes overview displays total, running, and stopped counts when the organization holds at least ten Boxes, preserving main’s existing threshold. Counts remain independent of list filters and pagination; loading uses the existing placeholder. The overview sits between the title and toolbar with 24px gaps.

Registry credential guidance belongs to the relevant form fields, not a permanent list footer. The secret field explains that saved credentials cannot be viewed; the repository-prefix field retains scope guidance and briefly explains longest-prefix precedence. Both Connect and Update show these notes without repeating them in the dialog introduction.

## Filter and keyboard boundaries

Boxes displays the API’s filtered total beside its filter, independent of the current page size. While a replacement request retains placeholder rows from the previous filter, the count shows `—` until the new total arrives. Registry filtering uses the same Covers label shown in rows, including `every repository` and a scoped prefix’s trailing wildcard. Pending registry requests display a loading status and an unknown count rather than zero. Card keyboard navigation handles only events targeting the card itself; nested controls retain native Enter/Space activation.

Destruction events decrement cached totals only when the Box is present in that cached page, preventing duplicate or unrelated events from subtracting again. Terminal destruction events also refetch active organization Box queries so off-page matches and pagination totals are reconciled by the server instead of guessing local filter membership.
