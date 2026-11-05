# New-user onboarding

Welcome collects the organization name and use case before offering card setup,
promo redemption, or direct entry to Quickstart.

## Card setup and optional credits

The steps are Organization, Use case, and Get credits.
The organization form includes terms and privacy links with an explicit checkbox;
that confirmation is local form state. The organization API continues to save the name only.
Confirmed name changes survive reloads before use-case submission.

Card setup shares Wallet's `useConnectCard` operation: open a tab on the click,
fetch `GET /organization/{id}/checkout-url`, and navigate that tab to Stripe.
If the browser blocks the tab, a persistent notification provides an Open Stripe
link to the returned checkout page.
An unsuccessful request closes the empty tab and shows the existing error toast.
Returning to Welcome refreshes the wallet and payment methods, including data
still inside the ordinary five-minute cache window. A connected card is confirmed
by `creditCardConnected`; opening or closing Stripe is not confirmation.
Card status and saved-card details are visible only to the current owner, even
when the query cache retains data from an earlier owner session.

Promo submission uses `useRedeemCouponMutation` with the entered code unchanged.
The shared billing client encodes the code as one URL path segment, preserving
characters such as `#`, `?`, `/`, and `%` in both Welcome and Wallet requests.
The shared mutation refreshes wallet, transactions, invoices, plan, and usage.
The response supplies a message, not a redemption amount; the success panel displays
that message and receives keyboard focus after redemption. Card-status refreshes
leave keyboard focus in place. Card success says Card connected. Neither success
state asserts reward delivery. Reward processing belongs to the billing service.

Start quickstart and Explore with BoxLite record `completedAt` under the existing
user-and-organization storage key. Completion is independent of wallet balance.
Refresh before completion resumes Get credits once the use case has been saved.
Installations without billing complete after saving the use case.

The current billing contract has no reward-delivery read. Welcome and Wallet
therefore perform no reward polling. The shared operations use the existing API;
organization name and use-case persistence keep their current contracts.

## Quickstart and prompt drafts

Quickstart offers SDK/CLI examples, console templates, and a prompt for a local coding agent.
Console creation uses the selected image, resource defaults, and startup command.
The PostgreSQL + pgvector template generates `POSTGRES_PASSWORD` in the Box environment.

1. Prompt text autosaves after one second and on blur, scoped to the organization and user; refresh restores it.
2. **Prepare prompt** saves a handoff snapshot; **Copy prompt** then writes locally without waiting for a network request.
3. Editing the request requires preparation again and invalidates the old copy confirmation and its retries.
4. Failed copy acknowledgements can be retried independently; each retry stays bound to the handoff actually copied.

Credentials are added only in the browser and never persisted in the handoff.
Switching user or organization clears displayed credentials and isolates late key-creation responses.
A successful copy does not establish deployment.

## Deployment

Deploy the additive migration and onboarding API before the dashboard.
See the [API persistence contract](../api/onboarding.md) for authorization,
validation, revision conflicts, and retention.

Regenerate both cloud API clients whenever the onboarding DTOs or controller change,
using the repository's pinned OpenAPI generator.

## Resuming Welcome

- Only first-run organization owners automatically enter Welcome; members can explicitly open Quickstart.
- Completion, including **Explore with BoxLite**, is restored for the same user and organization in the same browser.
- Completion does not establish reward delivery and is not synchronized across devices.

## SDK Quickstart previews

The SDK/CLI path continues from running a command to serving a small HTTP page
on port 3000. Python, Node, Go, Rust, C, CLI and REST all use the same three-part
program: create a Box with inbound networking enabled, execute a command, then
start a Python HTTP server in the guest and print its public preview URL.
The URL is public and does not require the API key. The script exits without
stopping or deleting the Box; users manage their resources in Boxes. Cloud idle
auto-stop still applies (15 minutes by default), so the URL is not guaranteed
to remain available indefinitely.

Save the three displayed parts in order in the named file, or use **Copy full
example**, then run the file once. Each section and the full example come from
the same template. The server source is included in the program, so users do
not need a second file or additional guest packages. See the
[installation command contract](README.md#sdk-and-cli-quickstart-readability).
CLI and REST discover the organization route through `/v1/me`;
these examples require curl and jq. Piped API keys bypass terminal echo controls;
an empty CLI tunnel response fails instead of printing an unusable preview URL.

Templates live in `src/lib/quickstart/templates`. Explicit step markers delimit
creation, execution and preview. Keep the Box and server running after the
local program exits. Dev acceptance tests should check the public page after
process exit, then remove only their own test resources independently.

Template validation rejects unknown template references and missing step sections
before returning copyable code. Boundary tests exercise both failures using the
real registry and template assets, preventing incomplete programs from reaching users.
