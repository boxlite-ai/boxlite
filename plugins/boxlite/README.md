# BoxLite plugin v0.1

A skills-only plugin for Codex desktop and CLI. It contains BoxLite setup/deployment skills and references for identity, durable storage, and operations. Applications are generated or adapted in the user's project; the package has no website template, app runtime, MCP server, or lifecycle hook.

From the repository root run `make plugin:boxlite:check` and `make plugin:boxlite:dist`. The latter produces a plugin ZIP and a standalone local marketplace in `target/plugins/boxlite-marketplace`. Add that directory with `codex plugin marketplace add ABSOLUTE_PATH`, then install `codex plugin add boxlite@boxlite`. For desktop development, the repository marketplace also exposes BoxLite as available; restart the app and select that source. Verify both installation paths separately.

This is a development package. Public release requires a tested CLI release of **v0.10.6 or newer** meeting the [setup skill's #1836 build prerequisite](skills/boxlite-setup/SKILL.md) and supporting `network tunnel`, real Auth0 device login and refresh verification, independent deployment acceptance, desktop installation evidence, publisher metadata/policy requirements, and review evidence. Application Google login needs its own client configuration when testing that use case. The CLI fix does not enable grants in the Auth0 tenant. Public submission/review is separate from local installation.

Use the references from each skill for the requested workflow. Keep application source, credentials, build caches, and deployment state outside this package.

Packaging reports absent manifests, non-object JSON, and missing required fields as contextual `ValueError`s. Validation and distribution always run, even when files share their Make target names; the non-colon force prerequisite preserves the macOS Make workaround.

The [setup skill](skills/boxlite-setup/SKILL.md) bundles the production public Native CLI client ID for `https://app.boxlite.ai/api` with issuer `https://auth.boxlite.ai/`, an explicit device-login command, and a browser PKCE alternative. Other environments require their own public Native CLI client ID from the environment administrator; the production ID must match the selected API and issuer. User/admin overrides remain supported. The package contains no client secret or user tokens.
