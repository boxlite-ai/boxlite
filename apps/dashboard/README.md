# BoxLite console

The web console at `app.boxlite.ai`. A Vite + React app, built and tested
through Nx as the `dashboard` project.

## SSH access

Open a box's **SSH** tab beside **Shell**. Setup, Enable and Disable require a
running box and permission to write boxes. Setup opens a dialog, generates
independent Ed25519 host/client keys in the browser, and configures login `box`
on guest address `0.0.0.0:22` through the existing SSH REST API. It replaces any
previous accounts and host identity and disconnects current SSH clients.
Before submitting the SSH configuration, Setup enables inbound access if it is
disabled and refreshes the box's network state. If enabling inbound fails, Setup
stops and retains the generated key for retry. Enable and Disable do not change
inbound access; a later SSH configuration failure does not turn inbound off.

Download the private key from the dialog before leaving the page. The client
private key stays in component memory and the downloaded file; only its public
key is sent to the server. The host private key is sent as part of the guest
configuration. Closing and reopening the dialog preserves the current download;
reloading, navigating away, or changing boxes/organizations discards it. A fresh
Setup then creates new identities. Failed setup retains generated keys for a
manual retry. Browser Ed25519 support and a secure context are required.

The dialog supplies an OpenSSH command using
`ProxyCommand=boxlite --path-prefix=… ssh --proxy -- BOX`, matching the
cloud CLI syntax in [#2327](https://github.com/boxlite-ai/boxlite/pull/2327).
Use a CLI build containing that change. The command uses the current CLI context;
it supplies neither `--context` nor `--url`. Run `boxlite context ls` to confirm
the current context matches the API address shown in the dialog and can access
the selected organization. Switch with `boxlite context use` if needed.
From the download directory, run the
displayed `chmod 600` and SSH commands; SSH starts and stops the proxy itself,
without a separate forwarding terminal or local listening port. The
organization argument survives shell quoting and OpenSSH percent expansion.
Ordinary IDs need no inner quotes; special characters remain safely quoted.
API credentials are loaded by the CLI, never embedded in the command.

Compare the displayed host fingerprint before accepting it; a fresh Setup may
change it. The cloud proxy requires server tunnel support and inbound access.
It opens a public tunnel protected by SSH authentication; exiting SSH leaves
the tunnel declaration open.
Setup itself does not open a tunnel.

The connection dialog scrolls as one document. Command blocks retain their full
height and wrap long lines, including on narrow screens; wrapping does not insert
newlines into copied commands.

Enable and Disable reuse saved credentials. SSH status errors remain visible;
mutations are not automatically retried. Switching tabs preserves the shell.
The SSH tests cover delayed reads and mutations completing after a refresh,
and a box stopping during key generation: obsolete responses cannot overwrite
the latest status, and obsolete generated credentials cannot configure the box.
While setup is pending, the connection dialog stays open so the download is not
lost through an accidental close.
Mock preview simulates these actions with a clearly marked mock host fingerprint;
it does not start an SSH server. See [the design](https://github.com/boxlite-ai/boxlite/issues/2325).

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
The Private registries tab provides credential setup. New box in the filter
toolbar opens the existing create dialog, while row actions prefill an image.
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
`permissions` array; see [API key delegation and member scopes](../API.md).
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

Connection guidance is available in the collapsed "How to connect a domain"
section. Successful requests clear filtering and show a reservation confirmation.
Late results from a previous organization invalidate that organization's cache
without showing a success notification in the current organization.

Run `make test:apps:dashboard` for page/client tests and
`make build:apps:dashboard` for the production build and type check.
