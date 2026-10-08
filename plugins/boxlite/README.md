# BoxLite plugin v0.1

A skills-only plugin for Codex desktop/CLI and Claude Code. It contains BoxLite setup/deployment skills and references for identity, durable storage, and operations. Applications are generated or adapted in the user's project; the package has no website template, app runtime, MCP server, or lifecycle hook.

From the repository root run `make plugin:boxlite:check` and `make plugin:boxlite:dist`. The latter produces a plugin ZIP and a standalone local marketplace in `target/plugins/boxlite-marketplace`. Add that directory with `codex plugin marketplace add ABSOLUTE_PATH`, then install `codex plugin add boxlite@boxlite`. For desktop development, the repository marketplace also exposes BoxLite as available; restart the app and select that source. Verify both installation paths separately.

For Claude Code, run `make plugin:boxlite:check:cc`, then:

```sh
claude plugin marketplace add ABSOLUTE_PATH_TO_TARGET_PLUGINS_BOXLITE_MARKETPLACE
claude plugin install boxlite@boxlite
claude plugin list
claude plugin details boxlite
```

The generated marketplace contains both host catalogs pointing at the same plugin. Claude Code reads `.claude-plugin/plugin.json` and discovers the shared `skills/` directory. In a new session, invoke `/boxlite:boxlite-setup` to set up developer authorization or `/boxlite:boxlite` for deployment. These do not authenticate automatically upon installation. For source development without installation, use `claude --plugin-dir ABSOLUTE_PATH_TO_PLUGINS_BOXLITE`.

Use a temporary `CLAUDE_CONFIG_DIR` for installation tests. Inspect `plugin list` and `plugin details` to confirm both skills load; this does not prove live device login or deployment. Tested CLI versions and outstanding acceptance checks belong in the release evidence. Claude web chat is outside this adapter's scope.

This is a development package. Public release requires a tested CLI release containing discovered device endpoints and `network tunnel`, real Auth0 device login and refresh verification, independent deployment acceptance, desktop installation evidence, final publisher policy URLs, and review evidence. Application Google login needs its own client configuration when testing that use case. The CLI fix does not enable grants in the Auth0 tenant. Public submission/review is separate from local installation.

Use the references from each skill for the requested workflow. Keep application source, credentials, build caches, and deployment state outside this package.
