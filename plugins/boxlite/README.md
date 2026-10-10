# BoxLite plugin v0.1

A skills-only plugin for Codex desktop and CLI. It contains BoxLite setup/deployment skills and references for identity, durable storage, and operations. Applications are generated or adapted in the user's project; the package has no website template, app runtime, MCP server, or lifecycle hook.

The portable entry point is `plugin.json`; `.codex-plugin/plugin.json` supplies the Codex compatibility overlay. Setup and deployment guidance lives under `skills/`. Install this folder through a compatible local marketplace and invoke the skill for the requested workflow. Installation itself does not authenticate to BoxLite.

This is a development package. Public release requires a tested CLI release of **v0.10.6 or newer** meeting the [setup skill's #1836 build prerequisite](skills/boxlite-setup/SKILL.md) and supporting `network tunnel`, real Auth0 device login and refresh verification, independent deployment acceptance, desktop installation evidence, publisher metadata/policy requirements, and review evidence. Application Google login needs its own client configuration when testing that use case. The CLI fix does not enable grants in the Auth0 tenant. Public submission/review is separate from local installation.

Discovery tags describe BoxLite cloud deployment through CLI skills. They apply across application stacks; PostgreSQL is an application choice rather than a plugin prerequisite.

Use the references from each skill for the requested workflow. Keep application source, credentials, build caches, and deployment state outside this package.

Setup uses local CLI help and bundled instructions first. Online installation documentation is a conditional reference for missing information or current release verification; a documentation fetch failure alone does not block login or the pinned source-build fallback.

Before the required CLI release is available, the setup skill executes a [pinned source-build fallback](skills/boxlite-setup/references/source-build.md) when no verified compatible CLI is installed. The agent fetches the merged #1836 source, runs the repository's dependency/runtime/CLI Make targets and selects that development executable before login. Keep the checkout for its runtime resources. The plugin ZIP contains the procedure; source and build outputs remain outside the plugin.

The [setup skill](skills/boxlite-setup/SKILL.md) bundles the production public Native CLI client ID for `https://app.boxlite.ai/api` with issuer `https://auth.boxlite.ai/`, an explicit device-login command, and a browser PKCE alternative. Other environments require their own public Native CLI client ID from the environment administrator; the production ID must match the selected API and issuer. User/admin overrides remain supported. The package contains no client secret or user tokens.
