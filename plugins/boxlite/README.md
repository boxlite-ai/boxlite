# BoxLite plugin v0.1

A skills-only plugin for Codex desktop and CLI. It contains BoxLite setup/deployment skills and references for identity, durable storage, and operations. Applications are generated or adapted in the user's project; the package has no website template, app runtime, MCP server, or lifecycle hook.

The portable entry point is `plugin.json`; `.codex-plugin/plugin.json` supplies the Codex compatibility overlay. Setup and deployment guidance lives under `skills/`. Install this folder through a compatible local marketplace and invoke the skill for the requested workflow. Installation itself does not authenticate to BoxLite.

This is a development package. Public release requires a tested CLI release meeting the [setup skill's #1836 build prerequisite](skills/boxlite-setup/SKILL.md) and supporting `network tunnel`, real Auth0 device login and refresh verification, independent deployment acceptance, desktop installation evidence, final publisher policy URLs, and review evidence. Application Google login needs its own client configuration when testing that use case. The CLI fix does not enable grants in the Auth0 tenant. Public submission/review is separate from local installation.

Use the references from each skill for the requested workflow. Keep application source, credentials, build caches, and deployment state outside this package.

The [setup skill](skills/boxlite-setup/SKILL.md) bundles the verified public Native CLI client ID for `https://dev.boxlite.ai/api` with its matching issuer and an explicit device-login command. Production and other environments require their own public Native CLI client ID from the environment administrator; the development ID must not be reused. User/admin overrides remain supported. The package contains no client secret or user tokens.
