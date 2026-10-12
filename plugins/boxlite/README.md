# BoxLite plugin v0.1

Build or adapt an app, deploy it through the BoxLite CLI, return its registered HTTPS URL, and update it while retaining its Box and data. Shared skills support Codex desktop/CLI and Claude Code.

## Install and use

For a standalone marketplace supplied as a test package, extract it and use its absolute directory:

~~~sh
codex plugin marketplace add ABSOLUTE_MARKETPLACE_DIRECTORY
codex plugin add boxlite@boxlite
~~~

For Claude Code:

~~~sh
claude plugin marketplace add ABSOLUTE_MARKETPLACE_DIRECTORY
claude plugin install boxlite@boxlite
claude plugin list
claude plugin details boxlite
~~~

Start a new session. Ask: **Help me build and deploy an application on BoxLite.** For an existing project: **Deploy this project to BoxLite and give me its public URL.**

Claude Code also accepts /boxlite:boxlite-setup and /boxlite:boxlite. Repository development can use claude --plugin-dir ABSOLUTE_PATH_TO_PLUGINS_BOXLITE. Installation alone does not authenticate the BoxLite CLI. Codex declares a bundled onboarding skill; Setup entry visibility depends on the host interface. Claude Code supports the setup skill command. You can also directly ask to build/deploy an app: its skill enters setup automatically when needed, reuses valid credentials, or starts device login and waits for browser authorization. It resumes the original task after verification.

## Supported workflow

[Setup](skills/boxlite-setup/SKILL.md) selects an official CLI v0.10.6+ or the provenance-verified [pinned native source build](skills/boxlite-setup/references/source-build.md), then authenticates the chosen profile. Production device login is the default; browser PKCE and user-controlled API keys remain alternatives. Other environments need their own public CLI client ID.

[Deployment](skills/boxlite/SKILL.md) checks the actual project, obtains a registered tunnel URL, stages compressed source, builds in the Box and verifies health/features. Its helpers use a private project configuration for repeat deployment, preserving shared configuration/data and the same Box/port URL. Database, app login and managed media references are read only when needed.

The optional deploy helper requires host Python 3.9+ and the guest's provided Python 3. It uses the standard library and installs no helper dependencies.

Keep app source, deployment state, credentials and CLI build caches outside this plugin. Online documentation is a conditional reference. This package has no application template, MCP server or lifecycle hook. Its optional helpers manage an app through the existing CLI.
