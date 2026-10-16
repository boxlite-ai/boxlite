# BoxLite plugin v0.1

Build or adapt an app, deploy it through the BoxLite CLI, return its registered HTTPS URL, and update it while retaining its Box and data. Shared skills support Codex desktop/CLI and Claude Code.

## Install and use

### From GitHub

You need Git, Make, Python 3.9+ and the Codex or Claude Code CLI. Download the source and generate the standalone marketplace:

~~~sh
git clone --depth 1 --branch main https://github.com/boxlite-ai/boxlite.git boxlite-plugin
cd boxlite-plugin
make plugin:boxlite:dist
~~~

This validates and packages the skills; it does not build the BoxLite CLI. Run the installation commands below from the cloned repository root. Keep the checkout because it provides the local marketplace source.

### Install in Codex or Claude Code

For a supplied test marketplace archive, extract it and replace the marketplace path below with the extracted marketplace's absolute directory.

~~~sh
codex plugin marketplace add "$PWD/target/plugins/boxlite-marketplace"
codex plugin add boxlite@boxlite
~~~

For Claude Code:

~~~sh
claude plugin marketplace add "$PWD/target/plugins/boxlite-marketplace"
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

## Privacy and support

BoxLite is provided by Polygala, Inc. See the [privacy policy](https://boxlite.ai/legal/privacy) and [service terms](https://boxlite.ai/legal/terms). Contact [support@boxlite.ai](mailto:support@boxlite.ai) for support and review questions; privacy requests go to [privacy@boxlite.ai](mailto:privacy@boxlite.ai).

The skills send user-selected application files and commands to BoxLite Cloud and use Auth0 for login. The CLI stores the selected profile's credentials locally. The optional deployment helper uses the selected CLI profile and rejects a nonempty BOXLITE_API_KEY environment variable before running commands; it does not forward credentials to an application's registered health URL. Source builds fetch the pinned official GitHub repository and its toolchains. Cloud retention and third-party processing follow the published policy.

Both listing icons use the same opaque white 512px square PNG, with the existing white-background brand artwork centered at its native size so the black outlines remain visible on dark host surfaces. Claude discovers its icon at .claude-plugin/icon.png; the OpenAI manifests reference assets/boxlite-icon.png. Keep these copies identical and preserve the white backdrop when updating the artwork. The Claude manifest sets the display name and public links explicitly so its support link does not depend on README-link inference.
