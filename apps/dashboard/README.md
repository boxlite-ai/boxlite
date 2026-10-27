# BoxLite console

The web console at `app.boxlite.ai`. A Vite + React app, built and tested
through Nx as the `dashboard` project.

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

## Finding your way around

Navigation is the sidebar plus the tables. There is one route per resource, and
each resource's table is the place you act on it — filter, sort, select, and run
per-row or bulk actions from there.

There is deliberately **no command palette**. The console had a `Ctrl/Cmd-K`
palette that re-listed the sidebar's routes, re-implemented each table's search
against a different data source, and exposed row actions a second time through
per-table command providers. Every command in it was a second, drifting copy of
an affordance the page already had, and keeping the two in step was a standing
cost paid on every table change. Search belongs to the table that owns the data;
actions belong to the row. If an action is hard to reach, fix the page.


## Two histories of the same thing go on tabs, not on top of each other

Invoices and credit activity both answer "where did my money go", so stacking
them made the Wallet tab a long scroll in which the second list was easy to miss
entirely. They are sibling tabs now, and each is paged rather than rendered
whole — an account with hundreds of documents must not decide how tall this page
is.

## A pending signup credit is announced only while it can still arrive

A new owner's wallet reads $0.00 until the signup credit is granted, so the
Wallet tab says it is on its way: "Registration rewards are being distributed,
please wait patiently." The billing service only reports whether the credit
has been delivered, and "not yet" also covers a credit that never comes: one
switched off, or an organization that does not qualify. Three rules keep the
notice from promising money that is not coming:

- Only a verified owner asks, and only for their default organization. No one
  else is granted a credit, so for anyone else "not yet" would never change.
- Reads stop after about two minutes, 2, 4, 8, 16, 30, 30 and 30 s apart, and
  the notice goes with them. Returning after the cached answer is dropped
  starts a fresh window.
- A failed read ends the wait as well, rather than polling the error.

When the credit lands, the wallet and its ledger are refetched before the
notice goes, so the balance changes as it disappears. `npm run start:mock`
reports every credit delivered; `localStorage['signup-credit-pending'] = '1'`
holds it back for six seconds.

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
promise a registration step that does not exist. It says how an image arrives
instead, as three steps across the top: connect a private registry if the image
needs one, start a box from it, and it is listed once the box runs. The first
is the only step a reader may have to take beforehand, so it links to Private
registries; the second opens the box create.

Every image row and every built-in image offers "New box", the same create
dialog the Boxes page uses with the image filled in, so starting from an image
is one click wherever the image is shown. The SDK call for the same start sits
behind "Show the SDK call" for readers who will paste it rather than click.

Built-in images sit apart from the table. They are operator configuration with
no versions, size or recorded starts, so a row for them would be a line of
dashes, and a "never" under last started would be false.

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

Registry query and mutation tests use a real QueryClient with mocked API calls.
They verify organization isolation, refusal before sending an unscoped request,
and invalidation after successful changes. Page tests cover confirmation and
failed submissions, and API client tests check that removal refusals retain
their message through the shared interceptor. Panel tests cover the masked
secret and its cleanup on close, prefix completion, the `?connect=` link,
duplicates, and refusals named by box.

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
