# CLI device authorization discovery

Date: 2026-10-08.

## Problem and scope

The CLI discarded `device_authorization_endpoint` and constructed `/device/code`. A provider advertising `/oauth/device/code`, including Auth0, therefore received the request at the wrong path. Preserve the advertised endpoint, retain compatibility for providers that omit it, and make device cancellation and rejected authorization observable without exposing server response descriptions. No API authorization or credential format changes.

## Related work and decision

[RFC 8628 section 4](https://www.rfc-editor.org/rfc/rfc8628#section-4) defines the discovery extension. [openidconnect 4.0.1](https://github.com/ramosbugs/openidconnect-rs/tree/4.0.1) supports typed additional metadata and generic client construction. Extend that metadata rather than adding a second discovery request, provider hostname special cases, or a new HTTP OAuth implementation. Keep the existing issuer-normalization retry. Reject malformed advertised URLs through typed discovery parsing; fall back only when the field is absent.

The public-client request must let the OAuth SDK add `client_id` exactly once. In [oauth2 5.0.0 `src/endpoint.rs:129-146`](https://github.com/ramosbugs/oauth2-rs/blob/5.0.0/src/endpoint.rs#L129-L146), the public-client branch adds it to the form before appending extra parameters. Adding it as an extra parameter duplicates it. Retain `audience` as an extra parameter and `offline_access` in the requested scopes. Capture the CLI's actual HTTP form in integration tests and assert parameter multiplicity, values, and absence of a client secret.

Auth0 uses `unauthorized_client` for both a disabled grant and an unknown or wrong client. Give client-ID/issuer and grant checks instead of diagnosing every occurrence as a missing grant. Keep arbitrary server descriptions and parse bodies out of terminal output; the typed error category plus local checks is actionable without echoing untrusted text.

The device flow uses the SDK's pending/slowdown/expiry polling. Ctrl-C cancels that future without returning tokens to the caller. Report recognized OAuth categories and local recovery guidance; omit arbitrary response descriptions/bodies. Token storage, proactive refresh near expiry, and refresh-token rotation remain owned by the existing credentials/refresh path.

## Auth0 administrator checklist

[Auth0's device prerequisites](https://auth0.com/docs/quickstart/native/device/interactive) require a public Native application, Authentication Method None, and OIDC conformance. Configure each environment independently; preserve existing dashboard applications.

| Setting | Required configuration |
| --- | --- |
| CLI application grants | Device Code, Refresh Token, and Authorization Code for browser PKCE |
| Target API | Allow Offline Access enabled for the requested audience |
| Login connections | Enable the intended user login connections for the CLI application |
| Browser callback | `http://127.0.0.1:5555/callback`; device flow has no loopback callback |

Supply the public Native CLI Client ID through `--client-id` if server discovery advertises the dashboard SPA application. Flags override server values; `OIDC_CLIENT_ID` is only a fallback and cannot replace a client ID returned by `/api/config`. Advertising a dedicated CLI client through control-plane config is a follow-up; this change preserves existing config precedence. The CLI requests `openid profile email offline_access` and sends no client secret. [Refresh-token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation) can be enabled according to tenant policy; the CLI persists replacement tokens. Enabling grants is an administrator action, not a consequence of this code fix.

## Validation and limits

Token conversion retains optional refresh and ID tokens without synthesizing them. If `expires_in` is absent or cannot be represented as a time delta, the session expires five minutes after conversion. Function documentation records this fallback and the discovery tests' configuration-precedence and path-preservation contracts.

With production changes reverted, regression tests fail at the wrong endpoint, missing client/grant guidance, duplicated client ID, and cancellation; legacy endpoint behavior passes. Restoring the fix passes all 20 auth integration tests and 268 CLI unit tests with native dependency stubs. Tests cover discovery, device-request form encoding, client/grant rejection, denied/expired codes, cancellation, and persisted rotation. Stubs do not validate a VM or live tenant configuration. After administrator setup, complete real device authorization, confirm refresh-token issuance, refresh the session, and verify API identity before declaring live acceptance.
