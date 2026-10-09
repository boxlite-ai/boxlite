---
name: boxlite-setup
description: Set up the BoxLite CLI and authenticate to a BoxLite cloud account for deployment. Use for BoxLite onboarding or expired developer credentials, not application end-user Google sign-in.
---

Check `boxlite --version`, `boxlite auth login --help`, and `boxlite network tunnel --help`. Read the current official CLI installation guidance at https://docs.boxlite.ai/ and https://github.com/boxlite-ai/boxlite/tree/main/src/cli before installing or choosing a version. The v0.1 development build needs discovered device endpoints (POL-818) and network tunnels; do not assume a released binary contains them.

Keep developer credentials in the CLI's private store, outside app source and deploy archives. Respect an existing home/profile selected by the user. A new deployment may use its own named profile. Start with `boxlite --profile NAME auth status` and `auth whoami`; never print credentials files or request tokens in chat.

Select the API endpoint for the user's cloud environment before login. Hosted dev uses `https://dev.boxlite.ai/api`; hosted production uses `https://app.boxlite.ai/api`. Use the intended public Native CLI Client ID with `--client-id` when `/api/config` advertises the dashboard application. Flags override server config; `OIDC_CLIENT_ID` is only a fallback and cannot override a server value. Do not substitute a dashboard SPA client for the CLI client. A client ID is public application metadata, not a client secret or a user credential.

For hosted dev, the verified public Native CLI Client ID is `65jDMnMS82AV6NdZfOT4tMP0TUpvtDef`. Use it only with API `https://dev.boxlite.ai/api` and issuer `https://auth.dev.boxlite.ai/` (a trailing slash is optional). Confirm the issuer from the selected API's `/config` before using this default. An explicit client ID supplied by the user or environment administrator takes precedence. Once the user has selected hosted dev, run:

```sh
boxlite --profile NAME auth login --url https://dev.boxlite.ai/api --client-id 65jDMnMS82AV6NdZfOT4tMP0TUpvtDef --method device
```

Replace `NAME` with the selected profile. For production, self-hosted, or additional environments, obtain that environment's public Native CLI Client ID from its administrator before login; the dev ID must not be reused. Then run `boxlite --profile NAME auth login --url SERVER_API_URL --client-id PUBLIC_CLI_CLIENT_ID --method device` with the selected environment's values. Add another bundled environment mapping only after verifying its API, issuer, and device login. A future `oidc.cliClientId` config field requires CLI support before it can replace the explicit flag.

Present only the printed verification URL and one-time user code from the device response. Keep the process alive while the user completes browser authorization. For `unauthorized_client`, check the CLI Client ID and issuer, then ask the Auth0 tenant administrator to verify Device Code for that application. Refresh Token and API offline access must be enabled to obtain renewable sessions. Stop polling on denial, expiry, or user cancellation.

Browser PKCE (`--method browser`) is an alternative when the user's local callback is reachable and the client's allowed callback is `http://127.0.0.1:5555/callback`. Never claim a dashboard browser session automatically authenticates the CLI. API-key login, when the user chooses it, uses `--api-key-stdin`; do not put the key in argv or app code.

After successful authorization run `auth whoami`, then `list --format json`. Check account/project routing before creating resources. To verify refresh issuance inspect only the boolean presence of a refresh token locally, never its value. A successful login without one is usable until the access token expires; label refresh verification pending until a real refresh succeeds.

Continue with the bundled boxlite skill for application deployment. App Google sign-in uses separate application OAuth credentials, not this developer login.
