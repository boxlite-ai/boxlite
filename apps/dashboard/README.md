# BoxLite console

The web console at `app.boxlite.ai`. A Vite + React app, built and tested
through Nx as the `dashboard` project.

## New-account email policy

When the API rejects account creation with `disposable_email`, `email_required`,
or `invalid_email`, the console explains the email problem and offers
**Sign out and use another email**. These responses do not restart authentication
or offer a retry with the same identity. The explicit action uses `/logout` to end
the identity-provider session and return to the existing manual sign-in screen.
Other authorization failures keep their existing error handling.

## SSH access

The left **Network** section shows SSH state and its switch. The switch only
enables or disables saved configuration; it does not generate keys or change
inbound. Status refreshes on click, window focus, and every 30 seconds while
visible and idle. Reads skip pending operations and preserve mutation errors.
Unknown/loading states cannot be toggled. The header and sidebar share one
controller and component-scoped private keys.

**Connect via SSH**, beside start/stop, first opens an access confirmation.
Opening or cancelling it changes nothing. The confirmation explains that SSH
and inbound access will be enabled, and that missing configuration requires a
new private key. It also discloses that setup replaces SSH accounts and host
identity and disconnects existing clients.

After confirmation, the controller reads fresh SSH status, enables inbound if
needed through the existing network mutation, and enables saved SSH configuration
when disabled. Only the verified missing-configuration server response permits
initial setup. Other failures remain in the entry view with refresh/retry; they
never trigger key generation. Existing enabled SSH is reused without a setup POST.
The missing-config response is a point-in-time observation, not atomic
create-if-absent: concurrent configuration can be replaced by the existing setup API.
Partial success is retained; SSH failure does not undo an inbound change.

Setup still generates independent Ed25519 host/client keys in the browser and
configures login `box` at guest address `0.0.0.0:22`. The client private key stays
in memory and its downloaded file; only its public key is sent. The host private
key is part of the guest configuration. Browser Ed25519 support and a secure
context are required. The browser retains the generated host public key beside the
client key so a fresh server response can identify the host. This does not prove
that the client key remains authorized. An externally observed generation change
with the same host displays a reminder to check authorization. This public metadata
is not added to the SSH POST body.

Failed setup retains generated credentials. Continuing always rechecks status and
tries Enable when needed; only a new, verified missing-config response permits
resubmitting the same generated configuration. A matching host identity recovers a
configuration saved before a failed response, without another setup POST. An observed
different enabled identity discards the obsolete cached private key and path; temporary
disabled/empty identity status preserves them. Replacing existing configuration is
available only through the separate Reset confirmation, including from a failed
preparation's entry view. Reset preserves the existing key until inbound is ready
and the replacement configuration is about to be submitted.

Successful preparation opens the connection guide: CLI setup, private-key path,
and a copyable command once the path is valid. It contains no Enable controls.
CLI instructions start expanded every time the dialog is opened, regardless of SSH
status or previously stored preferences. **Hide commands** collapses them only for
the current opening; **Show commands** expands them again. Both are text actions,
and downloading a private key uses an outlined button. Background status refreshes
preserve the visibility choice. The browser does not detect local CLI installation or auth.
Download a new private key before leaving, then enter its actual path. A download
click does not establish that saving succeeded or reveal the destination.

The browser tab remembers only a validated key path and its host public key in
sessionStorage, scoped to endpoint, authenticated user, organization and box.
The saved path is bound to the observed host public key and cleared on a confirmed
identity change; disabled status with an empty identity does not clear it. Private
keys are never put in storage. Storage failures leave the connection guide usable.
Leaving or reloading the page discards generated keys; closing/reopening the dialog
keeps them in component memory. Resetting SSH is a separate explicit confirmation.
Cancelling a reset preserves the current key and path.
If Reset submission fails, the current key and the proposed replacement remain
separately downloadable. The replacement has a distinct filename and is reused
on an explicitly confirmed retry. A status exposing its host identity adopts it
and clears the previous path; seeing the old host does not discard an unresolved
replacement. Neither private key is stored beyond the mounted page. External
generation changes observed while disabled still warn about possible client-key
authorization changes after Enable.

Login and the SSH proxy explicitly select a dedicated context named
`dashboard:<normalized API endpoint>`, for example `dashboard:https://api.boxlite.ai`.
The first connection requires running the displayed login command to create that
context. Login supplies the Dashboard endpoint; the proxy supplies the organization
with `--path-prefix` and uses `ssh --proxy -- BOX`, matching
[the cloud CLI syntax](https://github.com/boxlite-ai/boxlite/pull/2327).
Both commands remove `BOXLITE_REST_URL` from their child environment. Their explicit
`--context` takes precedence over `BOXLITE_CONTEXT`, legacy `BOXLITE_PROFILE`, and
the saved current context. Login updates only the dedicated profile; it does not
change the current context or overwrite other profiles. Switching contexts in
another terminal therefore cannot redirect this command. Deliberately logging in
to a different endpoint under the same dedicated context name can still redirect
it; rerun the displayed login command to restore that context.

To troubleshoot the generated context, run
`env -u BOXLITE_REST_URL boxlite --context 'dashboard:<endpoint>' context show`
and `env -u BOXLITE_REST_URL boxlite --context 'dashboard:<endpoint>' context ls`,
substituting the exact name from the generated command. Check that its endpoint
matches the Dashboard. For manually written CLI commands, `BOXLITE_CONTEXT`,
`BOXLITE_PROFILE`, `BOXLITE_REST_URL`, and the saved current context still affect
selection; `env -u BOXLITE_REST_URL boxlite context show` shows the effective
context without the URL override. `boxlite context use NAME` changes the saved
current context for manual commands; explicit flags and environment context
selectors take precedence over that saved choice. `BOXLITE_API_KEY` still overrides stored bearer
credentials, including for generated commands; check it if authentication fails.

Empty/invalid paths hide the command. `~/`, spaces, quotes,
backslashes and literal percent signs are supported; control characters and
`${...}` expansion in user input are rejected. `~/` resolves against the terminal's
`HOME` for both chmod and SSH, including when it differs from the account home or
contains literal percent signs. Relative paths resolve in the terminal's working
directory. A relative filename equal to `none`, case-insensitively, is prefixed with
`./` so OpenSSH loads it as a key file. API credentials are loaded by the CLI, never
embedded in commands. Copy feedback belongs to the displayed command; a late copy
completion for an older path cannot mark the new command copied.
Compare the host fingerprint before accepting it. The cloud proxy requires server
tunnel support and inbound access; exiting SSH leaves the tunnel declaration open.
Setup itself opens no tunnel.

Connection preparation and command presentation require a running box and
WRITE_BOXES permission, because the SSH proxy creates a network tunnel. Read-only
members can inspect SSH status, but cannot enter the connection guide even when
SSH and inbound are already enabled. If access changes after preparation,
the guide hides the command and returns users to **Review access**. Mutations are
not automatically retried. Pending operations block overlapping actions and closing;
detail refreshes during mutations wait for the mutation to finish. Stale reads and
responses after stop, permission, account, endpoint or scope changes are ignored.
The title/close control stays fixed while the dialog body scrolls. Command lines
wrap without changing copied content. The terminal remains mounted throughout.

Tests cover consent, conditional creation, request ordering, permissions, partial
success, same-key retry, stale responses, storage isolation and reset cancellation.
The local MSW preview echoes the generated host public key and fingerprint, retains
saved configuration across Disable/Enable, and hides disabled listener identity like
the real service. It exercises the real Dashboard but does not start an SSH server
or prove a live cloud SSH handshake.

## ASCII action buttons

Use `AsciiButton` from `components/ascii` for console actions. It delegates to
`ui/button`, which owns the shared geometry, typography, focus, and disabled
styles; raw buttons remain appropriate for tabs and custom choices. Use native
links for route navigation.

| Purpose | Variant / size | Appearance |
| --- | --- | --- |
| Main create or submit action | `primary` / default | 36px high, monochrome fill |
| Row action | `secondary` / `sm` | 28px high, neutral border |
| Icon action or overflow menu | `secondary` / `icon` | 28px square; `icon-lg` is 40px for mobile |
| Destructive row action | `danger` / `sm` or `icon` | Red text/icon, red border on hover |
| Final destructive confirmation | `dangerSolid` | Solid red |

Keep square corners and the shared monospace font. Secondary actions use a cyan
border with a neutral surface on hover/open; they do not turn solid cyan.
Hover styles apply only to enabled controls. Keyboard focus uses a contrasting
outline in both themes. Preserve larger mobile primary targets with `h-11 sm:h-9`.

Import operation icons from `components/ui/icon`, whose aliases all use the
offline pixel collection. Give icon-only actions an `aria-label`, retain helpful
titles, and forward native props/ref through wrappers used by Radix triggers.
Choose variants and sizes instead of copying hover, padding, or border classes.

## Page width and alignment

Normal dashboard pages use the `page-container` class from `src/index.css`.
It follows the Images page's full-width layout, with no maximum page width:
16px side padding on phones, 24px from `sm`, and 40px from `lg`. Large screens
keep the same side padding as the content expands to fill the available width.
The root reserves scrollbar space so short and long pages share both content edges.
When stable gutters are supported, modal scroll locks do not add another body
margin for that same space. Browsers without support retain the lock's fallback.

Apply it once to a page root, or use `PageHeader` and `PageContent`, which share
the same rule. Keep banners, tabs, tables, and Quickstart panels aligned to
those edges; do not add another page-level width or horizontal padding inside
them. Individual inputs and explanatory text can retain readable width limits.
The initial welcome form, dialogs, and dedicated fullscreen terminal have their
own sizing because they are separate surfaces.

## SDK and CLI quickstart readability

The walkthrough uses a dedicated `quickstart-code` type style: 14px monospaced
text, 24px line height, normal letter spacing and preserved indentation. The
10px tracked label style is reserved for labels. Code panes scroll horizontally
instead of wrapping commands; longer sections show up to 420px before scrolling.
File and local-terminal headers keep copy actions separate from the code.

Installation commands use the package manager's current release without fixed
version numbers. Python uses `--upgrade` to update existing installations. Rust
uses a quoted wildcard requirement followed by `cargo update -p boxlite` to
replace older dependency constraints and refresh an existing lockfile,
and the example supplies the current tunnel API's `TunnelOptions`. The
C SDK command requires curl, jq and tar, and selects the first stable release
with a matching platform archive among GitHub's 100 most recent releases,
ordered by publication time. A
new release without its C archive is skipped; no match stops the download.
Extraction completes in a temporary directory before replacing `boxlite-c-sdk`.
Failed extraction preserves the previous SDK. A failed or interrupted
replacement restores it when possible. If restoration fails, the previous SDK
is retained in the staging directory and its path is printed to stderr.
Displayed and copied
commands both come from `src/lib/quickstart/interfaces.json`.

## Quickstart catalog

Coder Universal is no longer offered as a quickstart template. Its preset
requested 30 GB of disk, which exceeds a 10 GB per-box disk ceiling. Removing
the preset avoids offering a configuration those organizations cannot create;
its disk request has not been reduced without runtime validation. Existing
boxes and custom-image support are unaffected. Old `?template=coder` links use
the picker's existing unknown-template fallback and select Python.

## Region names

The console resolves shared-region names through `GET /api/shared-regions`.
An unknown region keeps its stored ID as the display fallback. Region names do
not depend on the selected organization, so switching organizations does not
refetch this list.

## Commands

Run these from `apps/`:

| Command | What it does |
| --- | --- |
| `yarn nx run dashboard:dev` | Dev server on `:3000`, proxying `/api` to `http://localhost:3001` |
| `yarn nx run dashboard:build` | Production build, with a typecheck pass |
| `yarn nx run dashboard:test` | Vitest suite |
| `yarn nx run dashboard:test --coverage` | Same, writing lcov to `target/coverage/dashboard` |

`npm run start:mock` (from `apps/`) serves the console against the MSW handlers
in `src/mocks`, with no backend and no login. Its `VITE_BASE_API_URL` must end in
`/api`: `ConfigProvider` appends routes to that base directly, while the
handlers are mounted under `VITE_API_URL`. When the two disagree, `/config`
goes unanswered and the console never leaves its loading screen.

The image catalog mock answers the way the API does, so the console can be
judged against real refusals rather than happy paths: a tenant image is listed
under the name its reference normalises to (`python` is
`docker.io/library/python`, the rule `src/lib/image-ref.ts` mirrors), removing
one is refused with 409 while any box not destroyed still references it, and
the 409 names those boxes by id, not by name. Pinning a tag refuses OCI-invalid
names and any existing name, even one bound to the same version, and an unpin
writes no history event.

Registry credentials and box creation are mocked on the same terms. A
credential is unique per registry and repository prefix, and removing one is
refused while a box pulls through it. A box created from the console shows a
first pull for a few seconds, then starts; reaching STARTED is what adds its
image to the catalog, as the API's registrar does. `localStorage
['registries-unsupported'] = '1'` answers the credential list with 501, as a
deploy without a secret store does.

`DASHBOARD_API_PROXY_TARGET` points the dev server at a remote API
(`https://dev.boxlite.ai`) through the same-origin proxy, so the browser never
makes a CORS-gated request.

The `test` target is inferred by `@nx/vite` from the `test` block in
`vite.config.mts`. Removing that block removes the target, and with it every
signal CI has about this app — see [the workflows
README](../../.github/workflows/README.md) for how its coverage is reported.

## Creation can finish before startup

Template creation and the ordinary create dialog share `useCreateBoxMutation`.
The Box API creates the resource before waiting up to 30 seconds for it to
start. A cold image pull can exceed that wait while continuing in the background.
When HTTP 408 carries `boxId`, the dashboard reads that exact Box in the selected
organization and opens its details. The details page polls transitioning Boxes
every three seconds and displays their actual state, including startup errors.

This path sends only one create request. It does not infer success from a name
or an error message. A timeout without `boxId`, another error status, or a failed
follow-up read remains an error. Deploy both API and dashboard changes for this
handoff; older APIs do not include the structured identity.

## Finding your way around

Navigation is the sidebar plus the tables. There is one route per resource, and
each resource's table is the place you act on it — filter, sort, select, and run
per-row or bulk actions from there.

Search and actions belong to their resource tables. The console has no command
palette duplicating those controls.

## Wallet history

Invoices and credit activity use separate, paginated tabs.

## Card setup and promo redemption share one billing flow

Wallet and Welcome use the same card setup operation: open a tab, request the
organization's Checkout URL, and navigate to Stripe. Returning to Welcome or
choosing Check card status refreshes the wallet and saved payment methods.
A connected card allows the user to continue without waiting for reward delivery.

Both pages redeem coupons through `useRedeemCouponMutation`. Success invalidates
wallet, transactions, invoices, plan, and usage so the next view reflects the
server's result. Welcome shows the returned message and offers Quickstart;
Explore with BoxLite is available without a card or coupon.

## A choice says what it does, and shows which one is picked

The quickstart offers two paths, so each card names its outcome ("Build an app
online — get a public URL" against "Run untrusted code — an isolated box") and
the picked one is drawn, not merely implied. The prompt it hands out carries the
endpoint the reader will actually use: `getRestApiUrl` resolves production's
origin even when the console itself is running against a mock, because the
prompt is pasted into someone's shell, not into this app.

## Selection follows the action, not the row count

A table's checkbox column exists to arm a bulk action, so a row that no bulk
action can touch is not selectable. `VolumeTable` is the worked example: delete
is its only bulk action, so `enableRowSelection` asks
`isVolumeDeletable(row.original)` and the checkbox renders disabled for volumes
already deleted or on their way out.

Gating only the count instead — leaving the row selectable and filtering later —
produces a toast that offers "Delete 0" and a confirmation for "these 0 selected
volumes". If a new bulk action arrives with a different eligibility rule, the
predicate becomes the union of them; it must never go back to a bare boolean.

## Empty states carry the first action

A resource table with no rows is not a blank page and not a takeover: it keeps
the page's own chrome and puts the first useful action inside the table's empty
state. The Boxes page is the worked example — an account with no boxes gets the
table's empty state with a button into the onboarding guide, rather than the
page being replaced by a separate panel.

The rule this follows: an empty list still has to say what the page is about and
what to do next, and any dialog it opens must be the same one the rest of the UI
opens. A second entry point to the same guide is a bug, not a convenience —
mounting one twice has already caused duplicate API keys to be minted
(issue #1491).

## Private registries are a tab of Images

Someone who needs a private image is already on the Images page, so the
credentials that let a box pull one are its second tab, not a top-level item.
That is also how the API nests them (`/api/images/registries`). Each tab is its
own route, `/dashboard/images` and `/dashboard/images/registries`, so a box's
pull error can link straight to the second; the old `/dashboard/registries`
redirects there. The static `registries` segment is routed before `:idOrRef`,
as the API orders its routes, or it would read as an image named "registries".

## A list with no create says how its rows arrive

The API has no create for an image: one enters the catalog when a box first
starts from it. So the Images page has no "New image" button, which would
promise a registration step that does not exist. One description below the title
explains the active tab: built-in/used images or private-registry credentials.
The Private registries tab provides credential setup with one toolbar Connect
action, including an empty list. Images has no independent New box action; use
Boxes to start from a new reference, or a catalog row action to prefill its image.
Quota information stays in the usage meter. The inline "How to add an image"
control expands the registry → New box → successful start steps on demand.
Its registry link preserves query parameters, including a suggested registry to connect.
Feature descriptions carry definitions, and empty states give a brief next action.
The list and usage refresh on mount and every 30 seconds in the foreground,
since image registration may finish after the Box startup notification.
Quickstart remains readable without Box write permission; its console creation
button is disabled with an explanation, and the creation handler checks permission.
Unavailable membership is distinguished from denied permission and offers a full-page
reload to retry the provider fetch without racing an organization switch.
Recovery preserves the console method, template and Box name in the Quickstart
URL; generated credentials stay ephemeral, and restored names retain validation.

Images lists only rows returned by the image catalog API: the organization's
registered images and the operator-configured system images. Quickstart's
public templates are recommendations and do not add rows, search results, or
counts to Images. An empty or failed catalog response must not insert templates
as a fallback. A template image appears here once the API returns it as an
organization or system image.

For members allowed to create boxes, every row offers "New box". If its reference
matches a Quickstart template, the action opens that template with its startup
configuration; otherwise it opens the shared create dialog with the image filled
in. Matching a template does not change an image's ownership or removability.
System images remain non-removable and do not count against the organization's
image limit; usage comes from the separate usage API, not the displayed row count.

A new organization with the default system-image configuration sees `base`,
`python`, and `node`, with zero organization image slots used. The operator may
configure additional system images, so three is not a fixed UI limit.

## A state the API records once is told in the past tense

Some fields are set once and never cleared. `upstreamMissingAt` is written the
first time a pull finds a digest gone from its registry, and nothing resets it
if the registry gets it back. The image page therefore says "Gone upstream 5h
ago", with "BoxLite's copy still starts boxes" on hover, rather than a present
tense "Missing" that would turn false the moment the registry recovered.
Likewise the pin history says "unpins are not recorded", because the API
writes no event when a tag is unpinned, and a history that dropped a tag
without saying so would look like a bug.

Pinning checks what the API will refuse before sending: a name that is not OCI
tag syntax, and a name already pinned, which the API refuses even for the same
version because there is no move. Repointing a tag is an unpin and a pin, and
the page says so where the tags are listed.

The same page lists every box that still references the image, stopped ones
included: those are exactly the boxes that block its removal. And who pinned a
tag is a member's name, or "first pull", never an identity-provider id.

## A failure carries the way to its fix

When the API's reason names something the reader can fix on another page, the
page showing the failure links there, already pointed at the fix. A box whose
private pull was refused for want of a credential shows "Connect a registry for
quay.io", which opens the credential form with that registry chosen
(`/dashboard/images/registries?connect=quay.io`). The match is on the API's
own wording, so it is tested against that wording, and an unrelated error gets
no link.

The same goes for slow states the API reports: a box creating during its
first pull says PULLING IMAGE, not STARTING, so a minute in that state reads as
work rather than a hang. And a box's image links to its catalog entry once a
start has put it there.

## Private registries say what to fetch, and what a credential covers

A credential is write-only once saved, and nothing can test it, so the form is
where it has to be right. It is built per registry: GitHub, Docker Hub, Quay
and each Container Registry host get their own steps (where to make the token,
which scope, what the username is), and the scope a credential will cover is
shown as it is typed (`ghcr.io/acme/*`), with an unterminated prefix completed
rather than refused. The registries offered are the API's default
`REGISTRY_PROXY_UPSTREAM_HOSTS`; a stack configured with others needs
`PROVIDERS` changed with it.

Refusals are named in the reader's terms: a duplicate says which scope already
has a credential, and a removal refused because boxes pull through it names
those boxes rather than their ids. A deploy with no secret store answers 501,
which is a state of the environment, not an error, so the panel says private
registries are off there and offers nothing to connect.

## Registry login tests

In Images → Registries, **UPDATE** replaces a credential's username and password/token without destroying dependent Boxes.
It requires registry write permission, preloads the username and leaves the masked secret empty.
The registry and repository prefix stay fixed; enter a replacement secret and choose **Save changes**.

The UPDATE action uses the shared small ASCII button, matching image-row actions and the adjacent removal button's height.

Closing or completing the form clears its secret; failed submissions preserve the form for retry.
Closing a pending save clears inputs and mutation state without cancelling the request.
Save and row mutation actions remain disabled until it settles; an earlier completion never closes a subsequently opened form.

New private pulls check the current credential version and stop reusing old-version tokens after update commits.
Pulls already in progress may finish; the upstream token itself is not revoked.

Registry query and mutation tests use a real QueryClient with mocked API calls.
They verify organization isolation, refusal before sending an unscoped request,
and invalidation after successful changes. Page tests cover confirmation and
failed submissions, and API client tests check that removal refusals retain
their message through the shared interceptor. Panel tests cover the masked
secret and its cleanup on close, prefix completion, the `?connect=` link,
duplicates, updates with fixed scope, write permissions, and refusals named by box.

## Console API keys include member access

The key dialog creates a key with the user's available permissions. An owner's
new key includes `read:members` and `write:members`, displayed in the Members
permission group. A non-owner's key can include assigned member read access,
but never member write. Existing keys receive no additional permissions.

Create restricted keys through the API or SDK by supplying an explicit
`permissions` array; see [API key delegation and member scopes](../../docs/contributing/architecture/platform/api.md).
The scopes are independent, and an API key can only create keys with the same
or fewer permissions. Invitation acceptance in the console continues to use
the signed-in user's JWT.

## Every invitee joins as an owner

An organization has no finer roles yet, so inviting asks only for an email
address: a role picker would offer choices the product does not have. For the
same reason a pending invitation can be cancelled but not edited, and a member
can be removed but not given another role. The member whose personal
organization this is has no remove action, because the API refuses that
removal.

The profile menu's Organization entry opens two tabs. General shows the editable
name and copyable ID. Member combines members and outgoing invitations in one
table, with Member, Invited, and Expired statuses. Owners can invite, remove members,
and cancel invitations. Expired invitations offer Remove (with confirmation) and
Resend. Resending creates a new invitation with the same permissions and the current
default lifetime, then removes the expired record. Creation failure preserves the
old row; cleanup failure reports that the new invitation exists and refreshes both
rows, so the owner can remove the expired one. The old link remains unusable.
The page shows the current organization's name; switching stays in the profile menu.
The Member tab can be bookmarked at
`/dashboard/settings?tab=member`; older `/dashboard/members` links redirect there.

## Accepting an invitation opens the organization

Opening an email invitation link automatically accepts it after sign-in with the
invited email address. The console preserves the link through sign-in and makes
one acceptance request per visit, including under React effect replay. Expired,
cancelled, or mismatched invitations show an error and keep the current organization.

Email links are the only console entry for accepting invitations; there is no
personal invitation list or pending-count badge. Successful acceptance refreshes
the organization list, switches to the joined organization, and opens its Member tab.
Existing emailed URLs remain valid. Opening `/dashboard/user/invitations` without
an invitation ID redirects to the current organization's Member tab without accepting anything.

The new selection is saved only after membership validation succeeds. If switching
fails, acceptance still succeeds. The page explains that joining succeeded and
asks the user to switch through the profile menu. The console keeps the previous
organization both on screen and for the next reload.

## The organization you pick is the one you come back to

A user in more than one organization switches between them from the profile
menu, which marks the personal one. The pick is kept in `localStorage`, so the
next login opens the same organization; if the user was removed from it in the
meantime, the console falls back to their personal organization.

## New-user onboarding

The welcome flow saves organization intent, then offers card setup, promo redemption,
or direct entry to Quickstart.
[Onboarding](onboarding.md) describes the dedicated Quickstart page, public image templates,
server-backed prompt drafts, completion state, and deployment requirements.

## Box limits refresh without interrupting creation

Selecting an organization preloads its effective per-Box limits through the
organization detail API. The create dialog shares that query, refreshes on
opening and every 10 seconds while open in the foreground, and shows updated
Custom maxima without resetting the form. A named preset is recalculated from
its original size when limits change; Custom only reduces values that exceed a
confirmed limit. Subscription mutations invalidate the affected organization's
detail query without waiting for that refresh.

The query overrides the global five-minute freshness and previous-query
placeholder defaults, uses a 10-second request timeout, and passes cancellation
to Axios. Its key includes the organization ID and stored quota tuple so a new
organization or administrator quota edit cannot inherit unrelated limits.
Queries never replace membership DTOs or their per-user default flags.

Creation remains available while limits load. Until the first result, selected
resources reach server validation unchanged. Later refreshes keep confirmed
values; failures show a quiet inline notice. Normal background refreshes show
no toast or loading lock. The API's 30-second grant cache still applies, followed
by up to one polling interval and request latency before an open dialog updates.
See [Cloud sandbox sizes](../../docs/guides/resource-limits.md#cloud-sandbox-sizes).

## Domains

**Domains** is a primary navigation page alongside Images and Volumes. It lists
the selected organization's full hostnames and Box/port, App, or unbound targets.
The filter matches hostnames and target names/IDs. Request domain lives in the
resource toolbar; each row can copy its full hostname with explicit clipboard
feedback. Empty, filtered-empty, permission and load-error states are distinct.
Associated with links Box targets to their existing details page. App targets
remain text because the console has no App details route; unbound targets show —.
The page and request dialog use the shared console buttons and square surfaces.
Use **Request domain** to enter a short name and preview the full hostname; a
successful request holds the name without binding it. Quota and Box write
permission apply. Bind acquired full hostnames through the CLI or SDK; binding
does not request names, and App binding remains reserved. Unbinding retains
ownership and consumes the same quota slot.

The request dialog explains reservation versus binding; the list has no separate
connection-help footer. Successful requests clear filtering and show a reservation confirmation.
Late results from a previous organization invalidate that organization's cache
without showing a success notification in the current organization.

Run `make test:apps:dashboard` for page/client tests and
`make build:apps:dashboard` for the production build and type check.


## Neutral dark surfaces

Dark structural surfaces use zero-saturation gray: page background 4% lightness,
card 7%, popover 9%, hover/accent 12% and borders 16%. Sidebar, input, code and
scrollbar tokens follow the same neutral scale; brand and semantic status colors
keep their hues. Use these tokens instead of blue-gray literal backgrounds.
Light theme values are independent and unchanged by the dark palette.

For opt-in empty mock fixtures, see the desktop review section below.


### Desktop review: code surfaces, payment identity and empty resources

Saved payment methods use an explicit allowlist of locally bundled brand SVGs in
`src/assets/payment-brands` (license and pinned source included); unknown brands
retain an accessible generic card icon. Amounts, expiry validation and default-card
selection are unchanged.

Quickstart code wrappers use `quickstart-code-surface`: a visible neutral outline
and a separate code surface in each theme. This is local to Quickstart; copy values
and code whitespace remain unchanged. Console templates scroll with the page.
The selected template panel keeps its content height, and sticky positioning is
only enabled on desktop windows at least 800px high; shorter windows use normal flow.

Resource lists share `ResourceEmptyState`: a 48px neutral pixel-icon tile, 18px
heading, body copy below it, then optional secondary guide links. Creation stays
in the page toolbar under its existing permission guard. Images directs users to
Boxes; billing records have no creation CTA. Search misses, loading and errors
remain separate states. Quotas and other task-specific content above the list can
change its absolute vertical position without changing the empty-state anatomy.

For local mock review, `localStorage['desktop-review-empty'] = '1'` empties Boxes,
Images, Registries, Volumes, Domains, billing documents, credit activity and cost
series. API Keys are already empty by default. Set `SkipOnboarding_mock-user-00000000`
to `'true'` to inspect the returning-user empty Boxes list. Use the separate
`desktop-review-empty-members = '1'` only to inspect an unavailable membership list:
this also removes the mock user's membership and correctly hides owner actions.
Reset the two `desktop-review-empty*` values to `'0'` and reload for normal fixtures.

The shared resource module provides consumed empty-state, status, and filter primitives. Regression checks cover optional guidance, accessible status labels, empty/loading credit history, both money-history retry paths, volume filter recovery, clipboard failures and the exact-name deletion guard.

Resource lists use 24px pixel icons from `components/ui/icon`; status stays in its own indicator. Quickstart environment logos and payment brands keep their brand assets. The compact image summary alongside the filter shows `Custom images used / limit · Total image size bytes`. Both metrics cover organization-owned images, excluding curated images. Total image size is the sum of declared ready-version sizes, not deduplicated physical storage or a billing measurement. Only the count changes color near its quota; per-image Size cells and limit guidance remain.

Box inbound state means the proxy tunnel gate, not organization scope: disabled rejects tunnel traffic; enabled applies the public/private tunnel policy. Private tunnels accept a valid access token or organization authentication. Do not describe disabled as organization-only. Detail switches reserve space for their expanded hit targets, and outbound values may wrap.

Desktop visual comparisons and reproduction steps: [screenshot gallery](../../docs/contributing/investigations/assets/desktop-dashboard-review/README.md).

Resource headers leave 24px before the next section. Desktop filters share a 380×36px field, 13px input text, solid border and explicit accessible name. Toolbars precede list headers by 14px; Images and Domains usage wraps only when needed. Private registries supports local host, prefix and username filtering with clear-filter recovery. Boxes shows total, running and stopped counts for fleets of at least ten Boxes, independently of list filters or pagination. Its overview has 24px gaps above and below.

Billing pagers retain Previous on a failed later page with unknown totals. Cached Images refresh failures identify the retained rows as previously loaded data. Unknown invoice statuses preserve the upstream text. Create Box pricing and validation scroll inside the body while header and action footer remain visible.
