# OAuth acceptance and operator handoff

Public discovery, Auth0 configuration, native login, and workload authorization require separate evidence.
This runbook defines checks; it does not report successful production OAuth or directory approval.

```text
Local contract tests -> public discovery -> Auth0 operator configuration
                    -> native host login -> allowed/denied tool calls -> release evidence
```

## Checks without Auth0 management access

Run from the source repository:

```sh
make plugin:boxlite:check
make test:apps:api TEST_FILES='mcp|jwt.strategy|user.service.registration-email'
make test:apps:infra:auth0
make plugin:boxlite:preflight:oauth
```

The public preflight sends two metadata GETs and one unauthenticated MCP initialize request to fixed production URLs.
It never reads a host token store, sends credentials, follows redirects, creates workloads, or writes Auth0 configuration.

It checks the exact resource and issuer, reviewed scopes, CIMD and authorization-response issuer flags, public-client PKCE, and the 401 discovery challenge.
Requests have a 15-second timeout and a 64 KiB response limit; failures produce a nonzero exit and a redacted private report.

The report is `target/plugins/evidence/oauth-preflight.json`, outside every distributed ZIP.
A passing preflight establishes only public prerequisites; it cannot establish client registration, grants, the deployed login Action, or successful sign-in.

The API and infra tests exercise local code and simulated dependencies, not the production tenant.
The focused Auth0 target runs the tooling typecheck plus bootstrap, login-policy, email-provider, and MCP configurator tests.
It does not replace the full `make test:apps:infra` suite when changing broader infrastructure code.

## Auth0 operator handoff

Use the repository's [MCP identity deployment instructions](https://github.com/boxlite-ai/boxlite/blob/main/apps/infra/docs/identity-and-mail.md#mcp-client-sign-in).
An ordinary BoxLite API key cannot authorize these Management API operations.

1. Verify the stage, issuer, API audience, resource URL, login connections, and current deployed versions.
2. Apply the reviewed login Action for that exact resource, bind it, and run the required login canaries.
3. Preview the MCP configuration, resolve active Rules or validation failures, then apply tenant settings, client registrations, and grants.
4. Confirm a second preview has no changes and rerun the public preflight; retain the private journal for rollback.

If migrating away from the old API email-verification check, follow the documented Action-first rollout and token-lifetime wait.
Do not remove the old check before that migration requirement is satisfied.
An operator must validate each client's current CIMD document and the returned Auth0 client ID; a public discovery flag cannot prove registration succeeded.

## Account setup and native host login

Complete Dashboard registration with the same identity before first MCP use, including email verification and a default organization.
This candidate does not promise direct first-time registration from an MCP token without email.

An `email_required` or `registration_required` response requires completing Dashboard registration; an absent default organization requires organization setup.
Neither failure permits an account, credential, or organization switch without the user's explicit choice.

Install the final marketplace archive into an isolated native host profile and record its hash and the host version.
Use the bundled OAuth connection and native login UI; never read or export the host token cache.

For a separately configured Codex connection, the packaged authentication guide documents `codex mcp login`; Claude Code also exposes login in `/mcp`.
Record the actual tool namespace and returned account/organization context privately before any write.

## Acceptance matrix

| Case | Exercise | Expected result |
| --- | --- | --- |
| Existing user | Native login, consent, `listBoxes` | Authorized list, including an empty list; discovery alone is insufficient |
| First use | Register in Dashboard, then connect with the same identity | Existing account/default organization resolves without duplicate account creation |
| Email verification | Attempt MCP login as an unverified managed database user | Verification is required before a usable token is issued |
| Workload | Run applicable P2–P5 cases in `cases.json` | Hello, archive roundtrip, same-Box update, and explicit-ID cleanup |
| Permission denial | Attempt an excluded OAuth operation and a role-denied operation | Denied on the same connection, with no API-key fallback |
| Organization boundary | Attempt a known synthetic resource in another test organization | No access to that resource; use only operator-provisioned test IDs |
| Expiry and restart | Restart the host, then exercise token expiry | Valid native renewal or explicit reauthorization; no silent credential switch |
| Cancel and revoke | Cancel consent; separately revoke the test grant and reconnect | No successful cancellation claim; record refresh and access-token behavior separately |

Do not promise immediate invalidation of an already issued access token after grant revocation.
Record whether refresh tokens are actually issued and supported; if not, record the reauthorization experience instead of claiming refresh passed.
Wrong-issuer, wrong-audience, expiry, and signature checks can run locally using synthetic signed tokens; production security acceptance remains separate.

## Evidence and release gate

Record timestamps, host versions, archive hashes, case IDs, outcomes, and cleanup results in private evidence.
Exclude credentials, raw callback URLs, authorization codes, and token-bearing logs from both evidence shared with reviewers and public artifacts.

Mark `oauth_public_preflight` and `oauth_host_workflow` independently in the private release checklist.
Leave native cases pending while Auth0 configuration or browser authorization is unavailable, even if every local test passes.

The public kit includes this runbook and case definitions, not a production account, successful-login recording, or completed portal scan.
