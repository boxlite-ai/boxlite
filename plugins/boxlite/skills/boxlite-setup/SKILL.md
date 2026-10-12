---
name: boxlite-setup
description: Install a compatible BoxLite CLI and authenticate its developer cloud profile before deployment. Use for first-use BoxLite onboarding, missing CLI installation or expired BoxLite credentials, not an application's end-user login.
---

Run this workflow when the user starts BoxLite setup or first asks the bundled **boxlite** skill to build/deploy an app. Continue from the original app request after setup; do not require the user to find a Setup button or invoke another skill manually. Reuse a verified CLI and valid selected profile; installation alone does not start authentication.

## 1. Select a compatible CLI

~~~sh
command -v boxlite
boxlite --version
boxlite auth login --help
boxlite network tunnel --help
~~~

Expect: a verified official **v0.10.6+** CLI, or the provenance-verified pinned native build in [source-build](references/source-build.md), with device login and tunnels. Published v0.10.5 lacks the hosted device-endpoint fix; the pinned build may report v0.10.5 and is identified by source provenance.

If no CLI is installed, check the official release version. When a compatible release exists, set CLI_TAG to that published v0.10.6+ tag. Download its official installer into a temporary directory, verify checksum and provenance, then execute it:

~~~sh
INSTALLER_DIR="$(mktemp -d)"
(
  set -eu
  cd "$INSTALLER_DIR"
  gh release download "$CLI_TAG" --repo boxlite-ai/boxlite --pattern install.sh --pattern install.sh.sha256
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c install.sh.sha256
  else
    shasum -a 256 -c install.sh.sha256
  fi
  XDG_CACHE_HOME="$INSTALLER_DIR/cache" gh attestation verify install.sh --repo boxlite-ai/boxlite
  BOXLITE_VERSION="$CLI_TAG" sh ./install.sh
)
"$HOME/.local/bin/boxlite" --version
~~~

Checksum and attestation must both pass before execution. If gh, verification or a compatible release is unavailable, use the pinned source procedure; never bypass verification.

Expect: a compatible binary under ~/.local/bin. Retain its absolute path when PATH does not persist across tool calls. If no compatible release exists or an installed CLI is incompatible, execute the supported pinned source procedure and continue login. Give the user any administrator/interactive dependency step that requires their participation.

Use local CLI help and bundled instructions first. Online docs are only for missing information or current release verification; fetch failure does not block a verified executable or the source procedure.

## 2. Authenticate the selected profile

Respect the selected home, API and profile. If no profile was specified, inspect `boxlite auth status` and reuse the active profile; choose a named cloud profile only when no existing context applies. Use the CLI global `--home CLI_HOME` selector for a custom BoxLite home; this is not the operating system HOME. Check the reported credential source without displaying its value. In the examples, substitute the selected API/home, or omit a selector only when intentionally using its verified default.

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API auth status
boxlite --home CLI_HOME --profile PROFILE --url API auth whoami
~~~

Expect: online identity for the intended API. A successful check skips login. Missing credentials or an expired session that cannot refresh: read [login](references/login.md) and start the appropriate device command automatically, using its production mapping only for the matching API/issuer. Present the verification URL/user code and keep polling alive while the user authorizes in the browser.

DNS, TLS, transport, rate-limit or server failures are not proof that credentials expired: report the failing connection and preserve the profile instead of opening another login. Stop on denial/cancellation/expiry; do not retry authorization or change accounts to bypass the result. Browser PKCE and user-controlled API-key alternatives are in the login reference.

## 3. Verify routing and continue

~~~sh
boxlite --home CLI_HOME --profile PROFILE --url API auth whoami
boxlite --home CLI_HOME --profile PROFILE --url API list --format json
~~~

Expect: online identity and cloud resources using the same connection settings. Keep credentials private; never print the store or request tokens in chat. Return the verified executable/home/profile/API to the original **boxlite** workflow and continue the requested app task. A login-only request ends after these checks. Installation/discovery does not prove login or deployment.
