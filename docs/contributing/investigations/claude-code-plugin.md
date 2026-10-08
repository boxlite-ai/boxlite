# BoxLite skills in Claude Code

Date: 2026-10-08.

## Scope

Add Claude Code installation and discovery to the existing skills-only BoxLite package. Share the two skills and references with Codex. Do not add website source, MCP servers, hooks, a second CLI, or another authentication service. CLI login uses the same client configuration for each cloud environment; live device/refresh acceptance remains a separate configuration-dependent check.

## Related work and decision

[Claude Code's manifest reference](https://code.claude.com/docs/en/plugins-reference#standard-layout) defines `.claude-plugin/plugin.json` and discovers `skills/<name>/SKILL.md` by default. The existing root skills layout matches it. Add a small Claude manifest with portable identity fields; do not copy Codex presentation fields or duplicate skill sources. Use the default scan rather than listing the same skill directory twice.

[Marketplace creation](https://code.claude.com/docs/en/plugin-marketplaces#create-a-marketplace) requires `.claude-plugin/marketplace.json` with name, owner, and plugin source paths relative to the marketplace root. Generate that catalog beside the existing Codex catalog, both pointing at the same staged plugin. One ZIP contains both compatibility manifests; host-specific catalogs remain outside the plugin ZIP.

[Configuration locations](https://code.claude.com/docs/en/settings#find-or-create-your-settings-files) support `CLAUDE_CONFIG_DIR`. Use a temporary configuration directory for installation/discovery tests so existing user plugins and settings are preserved. Strict manifest validation and component inventory verify package structure; compatibility with older releases requires separate testing.

## Implementation

Validate name/version/description equivalence across portable, Codex, and Claude manifests. Preserve deterministic packaging and private-state exclusions. Generate both catalogs from the same staging root. Document `claude plugin marketplace add`, `claude plugin install`, and the namespaced `/boxlite:boxlite-setup` and `/boxlite:boxlite` entry points. Keep skill bodies host-neutral.

The installer checks establish installation and discovery, not real deployment or token refresh. No default permissions or credentials are added by this adapter. Public directory submission is independent from local marketplace installation.

## Validation

Run package tests for deterministic output, safe paths/private state, cross-host identity drift, and both catalog targets. Run `claude plugin validate --strict` on the source plugin and generated marketplace. In an isolated config, register the marketplace, install `boxlite@boxlite`, and inspect its enabled status and both discovered skills. Verify Codex packaging remains valid. Record real skill invocation and live login/deployment separately; do not substitute an inventory listing for either.
