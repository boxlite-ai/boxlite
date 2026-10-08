# CLI device authorization discovery

Date: 2026-10-08.

## Problem and scope

The CLI discarded `device_authorization_endpoint` and constructed `/device/code`. A provider advertising `/oauth/device/code`, including Auth0, therefore received the request at the wrong path. Preserve the advertised endpoint, retain compatibility for providers that omit it, and make device cancellation and rejected authorization observable without exposing server response descriptions. No API authorization or credential format changes.

## Related work and decision

[RFC 8628 section 4](https://www.rfc-editor.org/rfc/rfc8628#section-4) defines the discovery extension. [openidconnect 4.0.1](https://github.com/ramosbugs/openidconnect-rs/tree/4.0.1) supports typed additional metadata and generic client construction. Extend that metadata rather than adding a second discovery request, provider hostname special cases, or a new HTTP OAuth implementation. Keep the existing issuer-normalization retry. Reject malformed advertised URLs through typed discovery parsing; fall back only when the field is absent.

The device flow uses the SDK's pending/slowdown/expiry polling. Ctrl-C cancels that future without returning tokens to the caller. Report recognized OAuth categories and local recovery guidance; omit arbitrary response descriptions/bodies. Token storage, proactive refresh near expiry, and refresh-token rotation remain owned by the existing credentials/refresh path.

## Auth0 administrator checklist

[Auth0's device prerequisites](https://auth0.com/docs/quickstart/native/device/interactive) require a public Native application, Authentication Method None, and OIDC conformance. Configure each environment independently; preserve existing dashboard applications.

| Setting | Required configuration |
| --- | --- |
| CLI application grants | Device Code, Refresh Token, and Authorization Code for browser PKCE |
| Target API | Allow Offline Access enabled for the requested audience |
| Login connections | Enable the intended user login connections for the CLI application |
| Browser callback | `http://127.0.0.1:5555/callback`; device flow has no loopback callback |

Supply the public Client ID through `--client-id` if server discovery advertises another application. The CLI requests `openid profile email offline_access` and sends no client secret. [Refresh-token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation) can be enabled according to tenant policy; the CLI persists replacement tokens. Enabling grants is an administrator action, not a consequence of this code fix.

## Validation and limits

With production changes reverted, regression tests fail at the wrong endpoint, missing grant guidance, and cancellation; legacy endpoint behavior passes. Restoring the fix passes all 19 auth integration tests and 268 CLI unit tests with native dependency stubs. Tests cover discovery, grant denial, denied/expired codes, cancellation, and persisted rotation. Stubs do not validate a VM or live tenant configuration. After administrator setup, complete real device authorization, confirm refresh-token issuance, refresh the session, and verify API identity before declaring live acceptance.
