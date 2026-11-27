# Native cloud authentication

OAuth and API keys use the same production MCP service and tool contracts.
Configure credentials in the host, outside the distributed plugin; never place a key value on argv.

## OAuth registration

Complete initial registration in the BoxLite Dashboard before connecting; use the same identity and verify its default organization.
New MCP identities without an email claim cannot create a BoxLite account; existing accounts retain their stored profile when claims are absent.

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

## Verify and switch

Inspect schemas and call `listBoxes`; discover `getCurrentPrincipal` through the catalog when identity verification is needed.
Record the connection, authentication kind, and intended organization without the token.
Missing credentials or denial stops work; do not try another connection or cached OAuth.

For an explicit switch, stop using the old tool namespace and verify the newly selected identity.
Switching does not move or delete Boxes; IDs remain bound to their original backend and organization.
Local uses no cloud connection.
