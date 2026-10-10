# BoxLite Codex plugin v0.1

Date: 2026-10-08. Tracking: POL-818 (device authorization), POL-819 (skills-only plugin).

## Scope and observed behavior

Deliver a portable skills-only BoxLite plugin for Codex desktop and CLI. Its scope is setup/deployment skills, maintained references, plugin metadata, and package validation. It uses existing BoxLite CLI/SDK services. No website template, application implementation, MCP server, or lifecycle hook belongs in the package. Independent applications are acceptance fixtures, outside plugin source and distribution. Application identity is independent from the developer's BoxLite account: a generated application's Google OAuth credentials and sessions belong to that application. PostgreSQL can use guest persistent storage; uploaded media can use a managed volume. Existing deployments are outside the migration scope.

Before the authentication fix, the CLI discovered OIDC metadata but discarded `device_authorization_endpoint`, then constructs `/device/code` (`src/cli/src/commands/auth/oidc/device_code.rs:28`, `discovery.rs:130`). Auth0 discovery advertises `/oauth/device/code`. The cached openidconnect 4.0.1 implementation accepts additional provider metadata and its CoreClient constructor is generic over that metadata. Its existing device polling supports pending, slowdown, expiration, and refresh tokens. Reuse those contracts rather than introduce another OAuth client.

## Research and alternatives

- [RFC 8628 section 4](https://www.rfc-editor.org/rfc/rfc8628#section-4) defines `device_authorization_endpoint` in discovery; section 3.5 defines polling errors. Respect the advertised endpoint. Retain the existing Dex convention only when the field is absent for backward compatibility. A malformed advertised field must fail discovery, not silently select another endpoint.
- [Auth0 device authorization prerequisites](https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow/call-your-api-using-the-device-authorization-flow): native client, Device Code grant, optional Refresh Token grant, and API offline access. CLI code cannot grant tenant privileges. A dedicated public client is preferable to exposing a confidential client secret.
- [OpenID Connect Rust source, v4.0.1](https://github.com/ramosbugs/openidconnect-rs/tree/4.0.1): `AdditionalProviderMetadata` and generic `Client::from_provider_metadata` preserve discovery extension fields without a second HTTP request. A second bespoke discovery fetch would duplicate issuer validation and failure handling. Hardcoding an Auth0 hostname/path would fail other providers.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins): root `plugin.json`, root `skills/`, inline `extensions.com.openai`, and relative package paths. Local marketplaces and ZIP directory submission are distinct distribution paths. A compatibility manifest can support older clients; both manifests must stay equivalent.
- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission): submit a reviewed ZIP and required evidence; directory approval is external. No bundled MCP server or lifecycle hooks in v0.1.

- Shared deployment, identity, and operations guidance uses project-owned build, startup, secret configuration, and backup commands. Bundling a fixed application would impose an architecture that a general deployment skill does not require; application implementations stay outside the plugin.

## Implementation

POL-818 extends typed discovery metadata with an optional device endpoint. Browser PKCE and refresh continue using the same metadata and credentials store. Device login uses the advertised endpoint before the legacy fallback. Error messages report actionable OAuth error categories without echoing server descriptions, bodies, tokens, or URLs supplied by an error response. Ctrl-C cancels polling without persisting a partial session. Public clients let oauth2 add client_id once; adding it as an extra parameter duplicates the form field. Rejection guidance checks the public CLI client ID/issuer as well as the device grant. Setup selects the user's environment endpoint and dedicated CLI ID; flags override server config while environment variables are fallbacks. No token format or API authorization changes.

POL-819 puts the package under `plugins/boxlite`. It provides focused setup/deployment and operations guidance and packaging/validation automation. Preserve the existing agent-tooling marketplace entry. Add BoxLite as an available local entry for repository development; produce a standalone marketplace in distribution output for independent installation. Keep packaging generic to the documented skill resources rather than adding a template framework or app runtime. Pin tested CLI requirements and document browser/API-key fallbacks where device grant configuration is unavailable.

Public web deployments explicitly select `--inbound enabled` at creation; the default private mode rejects the tunnel. An existing private Box should use a supported inbound update rather than being replaced and losing its guest database.

Generated deployments record their Box and volume identities in a private project manifest, verify mount availability before accepting writes, and validate application inputs on the backend. Secrets are configured separately from distributable source. Application OAuth uses an exact public HTTPS callback, state validation, and secure sessions. Update/restart does not recreate database or media storage. Backup and restore instructions distinguish guest storage from media volumes.

Split deliverables into independently tested changes below the repository's 400 added engineering-line PR limit: CLI auth and plugin/package workflow. Template components are outside these deliverables. Documentation and tests remain with each behavior change.

## Validation and release gates

First add a real CLI subprocess regression fixture with discovery advertising a non-conventional device endpoint. Run unchanged production code and record failure at the login assertion; then implement and rerun. Cover legacy fallback, issuer trailing slash, unauthorized client, denied/expired tokens, missing credentials on failure, refresh rotation, and cancellation. Run existing auth tests and formatting checks using make. Stub-native builds validate CLI behavior, not VM execution.

Validate manifests, package paths, skill frontmatter, and absence of credentials/build caches. Check that the rebuilt archive and standalone marketplace contain the skills and no website source. Reinstall the development package to replace the cached starter. Verify desktop loading separately. Exercise deployment workflows against an independent application; verify mount behavior and restart persistence. Real application Google login is evidence for that use case, not a requirement to ship bundled application code. Record actual results separately from planned coverage. Tenant admin configuration, user authorization, and public review remain external gates; do not describe those gates as passed until observed.
