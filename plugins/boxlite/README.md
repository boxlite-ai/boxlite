# BoxLite plugin v0.1

A skills-only plugin for Codex desktop/CLI and Claude Code. It contains BoxLite setup/deployment skills and references for identity, durable storage, and operations. Applications are generated or adapted in the user's project; the package has no website template, app runtime, MCP server, or lifecycle hook.

Run `make test:unit:plugins` for package unit tests. Each distribution build replaces the entire generated marketplace directory, removing files from older builds. Keep personal files outside that directory.

Packaging requires Python 3.9 or newer. Unit tests, validation and distribution use `PLUGIN_PYTHON`, defaulting to `python3`; for example, `make plugin:boxlite:dist PLUGIN_PYTHON=python3.11`. Recursive package checks use the same interpreter. Coverage defaults to it too, but the pinned coverage.py requires Python 3.10 or newer; Python 3.9 users must select a separate Python 3.10+ environment with `PLUGIN_COVERAGE_PYTHON`.

From the repository root run `make plugin:boxlite:check` and `make plugin:boxlite:dist`. The latter produces a plugin ZIP and a standalone local marketplace in `target/plugins/boxlite-marketplace`. Add that directory with `codex plugin marketplace add ABSOLUTE_PATH`, then install `codex plugin add boxlite@boxlite`. For desktop development, the repository marketplace also exposes BoxLite as available; restart the app and select that source. Verify both installation paths separately.

For Claude Code, run `make plugin:boxlite:check:cc`, then:

```sh
claude plugin marketplace add ABSOLUTE_PATH_TO_TARGET_PLUGINS_BOXLITE_MARKETPLACE
claude plugin install boxlite@boxlite
claude plugin list
claude plugin details boxlite
```

The generated marketplace contains both host catalogs pointing at the same plugin. Claude Code reads `.claude-plugin/plugin.json` and discovers the shared `skills/` directory. Its discovery tags match the portable and Codex manifests. In a new session, invoke `/boxlite:boxlite-setup` to set up developer authorization or `/boxlite:boxlite` for deployment. These do not authenticate automatically upon installation. For source development without installation, use `claude --plugin-dir ABSOLUTE_PATH_TO_PLUGINS_BOXLITE`.

Use a temporary `CLAUDE_CONFIG_DIR` for installation tests. Inspect `plugin list` and `plugin details` to confirm both skills load; this does not prove live device login or deployment. Tested CLI versions and outstanding acceptance checks belong in the release evidence. Claude web chat is outside this adapter's scope.

The plugin supports either a verified official CLI **v0.10.6 or newer** containing [#1836](https://github.com/boxlite-ai/boxlite/pull/1836), or the verified native build from the [pinned source procedure](skills/boxlite-setup/references/source-build.md). The published v0.10.5 binary is incompatible; the pinned build may report that version and is accepted through source provenance.

The source path allows submission before a compatible CLI release exists. Public publication still requires independent deployment acceptance, installation evidence, publisher metadata/policy requirements and platform review. Application Google login needs its own client configuration when testing that use case. The CLI fix does not enable grants in the Auth0 tenant.

Discovery tags describe BoxLite cloud deployment through CLI skills. They apply across application stacks; PostgreSQL is an application choice rather than a plugin prerequisite.

Use the references from each skill for the requested workflow. Keep application source, credentials, build caches, and deployment state outside this package.

Setup uses local CLI help and bundled instructions first. Online installation documentation is a conditional reference for missing information or current release verification; a documentation fetch failure alone does not block login or the pinned source-build fallback.

When no verified compatible CLI is installed, the setup skill executes the pinned source-build procedure. The agent fetches the exact merged #1836 commit, runs the repository's dependency/runtime/CLI Make targets and selects that executable before login. Keep the checkout for its runtime resources. The plugin ZIP contains the procedure; source and build outputs remain outside the plugin.

Packaging reports absent manifests, non-object JSON, and missing required fields as contextual `ValueError`s. Claude compatibility requires matching names, versions and descriptions; package tests check drift in each field before output is staged. Validation, distribution, and Claude strict checks always run, even when files share their Make target names; the non-colon force prerequisite preserves the macOS Make workaround.

For measured packaging coverage, install `coverage==7.13.5` into a Python 3.10+ environment and run `make plugin:boxlite:coverage`. When packaging uses Python 3.9, pass `PLUGIN_COVERAGE_PYTHON=ABSOLUTE_PATH_TO_PYTHON_3_10_PLUS_ENVIRONMENT/bin/python`. This runs package tests plus the actual check/dist commands and writes `target/coverage/plugins/coverage.xml`; credentials and application runtime are outside its scope.

The [setup skill](skills/boxlite-setup/SKILL.md) bundles the production public Native CLI client ID for `https://app.boxlite.ai/api` with issuer `https://auth.boxlite.ai/`, an explicit device-login command, and a browser PKCE alternative. Other environments require their own public Native CLI client ID from the environment administrator; the production ID must match the selected API and issuer. User/admin overrides remain supported. The package contains no client secret or user tokens.

Isolated Make tests exercise both Claude strict-validation calls and stopping after a source-validator failure. The CLI boundary double checks invocation and error propagation; actual Claude compatibility requires the separate `make plugin:boxlite:check:cc` check.
