# Build and validate the BoxLite plugin

The source package lives under plugins/boxlite. Codex and portable manifests share identity fields and skill resources; update presentation metadata consistently.

~~~sh
make test:unit:plugins
make plugin:boxlite:check
make plugin:boxlite:dist
~~~

Distribution produces a plugin ZIP and a standalone marketplace in target/plugins/boxlite-marketplace. Each build replaces that generated directory; keep personal files elsewhere.

Packaging uses PLUGIN_PYTHON (default python3), Python 3.9+. Coverage requires a Python 3.10+ environment with coverage==7.13.5; select PLUGIN_COVERAGE_PYTHON separately when needed.

~~~sh
make plugin:boxlite:coverage PLUGIN_COVERAGE_PYTHON=PATH_TO_COVERAGE_ENV/bin/python
~~~

Unit coverage for packaging is distinct from cloud deployment acceptance. Archive tests exercise nested secret/cache exclusions and symlink rejection. Process helper tests run on Linux, including restart, stale PID refusal, lock contention, failed build preservation and failed-start rollback. On macOS those Linux-specific tests skip and must be run in a Linux guest or CI.

Use an isolated host config for installation tests, preserving existing plugins/settings. A listing is not authentication or application acceptance. A cold-start test must invoke the installed skill on a project, then verify first deployment, a changed feature after redeploy, the same registered URL, persisted data and Box stop/start recovery. Read only actual evidence as passed.

Application source belongs to the user's project. Private deploy.json stores explicit CLI/profile/Box/source and argv build/start commands; env.json is transferred separately into a mode-0700 guest shared directory and is mode 0600. No project state or environment values are distributed in the plugin. Helpers do not source dotenv text, recreate Boxes or register database/admin ports. Keep previous releases for startup rollback; inspect unknown build status before retrying.

## First-use authentication

Portable and Codex manifests declare the same onboardingSkill. Validate both so the compatibility host has the packaged setup entry. Setup is user-invoked; do not claim installation itself logs the CLI in. The deployment skill routes first-use requests into setup without requiring a separate user command.

Check a valid selected profile skips login, a missing profile starts device authorization, denied/cancelled requests stop, and a transport failure preserves credentials. Verify explicit CLI/home/profile/API context survives the return to the app task. CLI-token storage stays with the CLI; no MCP, install hook or host-token bridge is added.
