# Native cloud authentication

OAuth and API keys use the same production endpoint and MCP contracts.
Configure credentials in the host, outside the distributed plugin; never place a key value on argv.

## OAuth

Complete initial registration in the BoxLite Dashboard before connecting; use the same identity and verify its default organization.
New MCP identities without an email claim cannot create a BoxLite account; existing accounts retain their stored profile when claims are absent.

Use the bundled connection in the host MCP panel; Claude Code exposes it through `/mcp`.
For an independent Codex connection, use native commands:

```sh
codex mcp add boxlite-oauth --url https://api.boxlite.ai/mcp
codex mcp login boxlite-oauth
```

Do not add a duplicate when the bundled connection is available.
Keep OAuth credentials with the host and verify the returned organization context.

| Failure stage | Meaning | Next step |
| --- | --- | --- |
| Client registration, before the browser | Issuer/client configuration is unavailable or incompatible | Report the exact host error; an operator must check CIMD configuration |
| Login or consent | The user has not completed authorization | Let the user finish or cancel in the host/browser |
| `email_required` | First API use has no email for account creation | Complete Dashboard registration with the same identity |
| `registration_required` | The service requires the Dashboard registration flow | Complete Dashboard registration with the same identity |
| No default organization | OAuth cannot resolve the current default membership | Complete organization setup before workload operations |
| Scope or permission denial | The selected identity lacks access | Stop; preserve the chosen credential and organization |

Do not extract token claims to diagnose these errors; use returned error codes and the user's account setup.
Metadata discovery and browser consent alone do not establish permission to call tools.

## API key in Codex

Have the user supply their chosen key as `BOXLITE_API_KEY` to the host through a private environment or secret source.
The process running Codex must inherit it, not merely a transient child shell.
Check presence only:

```sh
test -n "${BOXLITE_API_KEY:-}"
codex mcp add boxlite-api --url https://api.boxlite.ai/mcp --bearer-token-env-var BOXLITE_API_KEY
```

Run the second command only after the first succeeds, then reload as required by the host.
Select only `boxlite-api` tools and disable the unselected OAuth connection when necessary to prevent duplicate tools.
Do not disable unrelated plugins.

## API key in Claude Code

After the same explicit key setup, add a user-scope entry with a literal placeholder. This keeps the connection private to your Claude user account and makes it available across projects.

```sh
test -n "${BOXLITE_API_KEY:-}"
claude mcp add-json --scope user boxlite-api '{"type":"http","url":"https://api.boxlite.ai/mcp","headers":{"Authorization":"Bearer ${BOXLITE_API_KEY}"}}'
```

Run the second command only after the first succeeds; single quotes prevent expansion of the key into argv.
Verify in `/mcp` that `boxlite-api` is active and the bundled OAuth entry is deduplicated or disabled.
Never write an expanded header into shared configuration, plugin caches, repositories, or review packages.

If a local entry already uses this name, verify the selected connection before transferring because Claude gives the local entry precedence in the original project. A project-only connection can be used directly by its name in the current session.

## Verify and switch

Inspect schemas and call `listBoxes`; discover `getCurrentPrincipal` through the catalog when identity verification is needed.
Record the connection, authentication kind, and intended organization without the token.
Missing credentials or denial stops work; do not try another connection or cached OAuth.

For an explicit switch, stop using the old tool namespace and verify the newly selected identity.
Switching does not move or delete Boxes; IDs remain bound to their original backend and organization.
Local uses no cloud connection.

## Distribution boundary

OpenAI's public portal currently lacks API-key setup and rejects nonempty server headers in submission ZIPs.
The package declares a clean OAuth endpoint; API-key mode uses supported native host configuration outside that package.
Do not claim availability on every public-directory surface or mark a protected endpoint unauthenticated.

References: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude MCP](https://code.claude.com/docs/en/mcp), [OpenAI limitations](https://developers.openai.com/plugins/deploy/submission#authentication-limitations).
