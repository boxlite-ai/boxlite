# Development CLI source fallback

Execute this procedure when the user requests setup with this development plugin and no verified compatible CLI is available. Prefer a verified official v0.10.6+ release when available. An already-built source CLI may be reused when its origin, full commit and normal native build are verified. This exception supports internal testing; it does not satisfy the public-release gate.

The pinned revision below is the merged #1836 commit, not its old PR branch. Its CLI may still report v0.10.5: record source provenance instead of changing the version or accepting the older published binary.

## Fetch and build

Check the host with `uname -s` and `uname -m`. The supported source-build hosts are macOS Apple Silicon and Linux x86_64/ARM64. Read the pinned repository's `AGENTS.md`, `docs/contributing/development/building.md`, `docs/contributing/development/cli.md` and Make targets. Linux local VM execution additionally requires KVM; hosted API login is a separate check.

Use a fresh source directory outside the plugin cache and application/deployment archives. Respect a user-selected location. The example uses a user cache; if it already exists, reuse it only after verifying the official origin, exact revision and clean tracked source. Otherwise choose a fresh directory. Never reset or delete a user's checkout to make this example fit.

Run these commands in one shell for a fresh directory, stopping on failure:

```sh
set -eu
BOXLITE_SOURCE_REV=e6cc3d1a1e991f8732f7b5c8f9eb4baa3c1bbbbf
BOXLITE_SOURCE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/boxlite/cli-source-$BOXLITE_SOURCE_REV"
git init "$BOXLITE_SOURCE_DIR"
git -C "$BOXLITE_SOURCE_DIR" remote add origin https://github.com/boxlite-ai/boxlite.git
git -C "$BOXLITE_SOURCE_DIR" fetch --depth 1 origin "$BOXLITE_SOURCE_REV"
git -C "$BOXLITE_SOURCE_DIR" checkout --detach FETCH_HEAD
test "$(git -C "$BOXLITE_SOURCE_DIR" rev-parse HEAD)" = "$BOXLITE_SOURCE_REV"
cd "$BOXLITE_SOURCE_DIR"
env -u BOXLITE_DEPS_STUB -u SKIP_GUEST_BUILD -u CARGO_TARGET_DIR make setup:submodules
env -u BOXLITE_DEPS_STUB -u SKIP_GUEST_BUILD -u CARGO_TARGET_DIR make setup:build
env -u BOXLITE_DEPS_STUB -u SKIP_GUEST_BUILD -u CARGO_TARGET_DIR make cli
BOXLITE_CLI="$BOXLITE_SOURCE_DIR/target/debug/boxlite"
"$BOXLITE_CLI" --version
"$BOXLITE_CLI" auth login --help
"$BOXLITE_CLI" network tunnel --help
```

`setup:build` installs platform dependencies; normal tool permissions still apply. `make cli` prepares the debug native runtime before compiling the CLI. Do not substitute a stub-only build or bare `cargo build` and call it deployment-ready. If dependencies, permissions or compilation fail, report the failing step and stop before login. Do not silently use an incompatible release after that failure.

## Select the built CLI

Keep the checkout and its `target` runtime resources in place. Use the absolute `BOXLITE_CLI` path for subsequent auth and deployment commands, preserving the user's home/profile. This makes the source CLI available without replacing another installation. Record the resolved binary path, full Git revision and a local SHA-256 checksum in private setup notes; never include credentials there.

To invoke it as `boxlite` in a shell, prepend its directory with `export PATH="$BOXLITE_SOURCE_DIR/target/debug:$PATH"` and refresh that shell's command cache. An export in one tool shell may not persist to the next: retain the absolute executable path or set the prefix in every subsequent call. Change a user's persistent shell configuration only when requested.

Verify that login help exposes `--method device`, `--client-id` and `--url`, and that tunnel help succeeds. Then return to the setup skill and execute its production login command using this selected executable. Help/version checks establish capabilities, not successful authorization or deployment; report those only after their real checks pass.

## Build references

- [Pinned CLI guide](https://github.com/boxlite-ai/boxlite/blob/e6cc3d1a1e991f8732f7b5c8f9eb4baa3c1bbbbf/docs/contributing/development/cli.md)
- [Pinned setup targets](https://github.com/boxlite-ai/boxlite/blob/e6cc3d1a1e991f8732f7b5c8f9eb4baa3c1bbbbf/make/setup.mk)
- [Pinned CLI/runtime targets](https://github.com/boxlite-ai/boxlite/blob/e6cc3d1a1e991f8732f7b5c8f9eb4baa3c1bbbbf/make/build.mk)
