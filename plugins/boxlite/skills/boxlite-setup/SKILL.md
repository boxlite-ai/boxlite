---
name: boxlite-setup
description: Set up the BoxLite CLI and authenticate to a BoxLite cloud account for deployment. Use for BoxLite onboarding or expired developer credentials, not application end-user Google sign-in.
---

If a CLI is installed, first check `boxlite --version`, `boxlite auth login --help`, and `boxlite network tunnel --help`. The v0.1 development package also requires network tunnels.

Start with local CLI help and this skill's bundled setup/build guidance. Consult https://github.com/boxlite-ai/boxlite/tree/main/src/cli and https://docs.boxlite.ai/ only when required installation information is missing or current release details need verification.

If an online documentation fetch fails, report it briefly and continue using verified CLI capabilities and the bundled instructions. That fetch failure alone must not block login or the pinned source-build fallback below.

Require BoxLite CLI **v0.10.6 or newer**, with `network tunnel` support. Hosted Auth0 device login requires the discovered-endpoint fix in [#1836](https://github.com/boxlite-ai/boxlite/pull/1836), merged into `main` on 2026-10-09 as [`e6cc3d1`](https://github.com/boxlite-ai/boxlite/commit/e6cc3d1a1e991f8732f7b5c8f9eb4baa3c1bbbbf). The published `v0.10.5` release predates that fix. `v0.10.6` is the minimum planned release; public plugin release remains pending until that CLI release is available and verified to contain the fix. Version output and `--method device` alone do not establish build provenance. Source builds containing #1836 may be used for development verification before the release.

For this development package, when no verified compatible CLI is available, execute the [source-build fallback](references/source-build.md) as part of the requested setup. Fetch the pinned merged source, prepare its native runtime, build and select the CLI, then continue authorization below. Do not stop solely because v0.10.6 has not been published. Keep a verified existing release/source build when available; report a concrete platform, permission or build failure if the fallback cannot finish.

Keep developer credentials in the CLI's private store, outside app source and deploy archives. Respect an existing home/profile selected by the user. A new deployment may use its own named profile. Start with `boxlite --profile NAME auth status` and `boxlite --profile NAME auth whoami`; never print credentials files or request tokens in chat.

Hosted production uses API `https://app.boxlite.ai/api`, issuer `https://auth.boxlite.ai/`, and public Native CLI Client ID `PniqOPOrdcQ1gx2aIBljtZuvhtigCM6C`. Confirm the issuer from the selected API's `/config` before applying this mapping (a trailing slash is optional). Use `--client-id` to select the CLI application when `/config` advertises the dashboard application. Flags override server config; `OIDC_CLIENT_ID` is only a fallback and cannot override a server value. A client ID is public application metadata, not a client secret or a user credential.

Once the user has selected hosted production, preserve any explicit user/admin `CLI_CLIENT_ID`; apply the bundled value only when that selected value is absent or empty:

```sh
boxlite --profile NAME auth login --url https://app.boxlite.ai/api --client-id "${CLI_CLIENT_ID:-PniqOPOrdcQ1gx2aIBljtZuvhtigCM6C}" --method device
```

Replace `NAME` with the selected profile. For self-hosted or additional environments, obtain that environment's public Native CLI Client ID from its administrator and run `boxlite --profile NAME auth login --url SERVER_API_URL --client-id PUBLIC_CLI_CLIENT_ID --method device`. The bundled production ID applies only to its matching API and issuer. Add another environment mapping after verifying its API, issuer, and device login. A future `oidc.cliClientId` config field requires CLI support before it can replace the explicit flag.

Present only the printed verification URL and one-time user code from the device response. Keep the process alive while the user completes browser authorization. For `unauthorized_client`, check the CLI Client ID and issuer, then ask the Auth0 tenant administrator to verify Device Code for that application. Refresh Token and API offline access must be enabled to obtain renewable sessions. Stop polling on denial, expiry, or user cancellation.

Browser PKCE is an alternative when the user's local callback is reachable and the client's allowed callback is `http://127.0.0.1:5555/callback`. Use the same selected profile, API and CLI client as device login; for hosted production run:
```sh
boxlite --profile NAME auth login --url https://app.boxlite.ai/api --client-id "${CLI_CLIENT_ID:-PniqOPOrdcQ1gx2aIBljtZuvhtigCM6C}" --method browser
```

Switch methods only after the device attempt has ended, preserving denial/cancellation decisions. Never claim a dashboard browser session automatically authenticates the CLI. API-key login, when the user chooses it, uses `--api-key-stdin`; do not put the key in argv or app code.

After successful authorization run `boxlite --profile NAME auth whoami`, then `boxlite --profile NAME list --format json`. Check account/project routing before creating resources. To verify refresh issuance inspect only the boolean presence of a refresh token locally, never its value. A successful login without one is usable until the access token expires; label refresh verification pending until a real refresh succeeds.

Continue with the bundled boxlite skill for application deployment. App Google sign-in uses separate application OAuth credentials, not this developer login.
