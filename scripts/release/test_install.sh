#!/bin/sh
# Smoke-test the rendered installer script.
#
# What this guards:
#   1. The template renders to a valid shell script (`sh -n`, shellcheck).
#   2. The install step uses a same-filesystem staged file plus atomic `mv`
#      over the target, so a failed mid-copy cannot corrupt an existing
#      `boxlite` binary in $install_dir. GNU coreutils `install` on Linux
#      truncates the destination in place (O_TRUNC on an existing file in
#      copy.c), so `install src dst` alone is NOT atomic on Linux even
#      though it is on macOS. The structural assertion below catches a
#      regression of the install-in-place pattern.
#   3. install.sh itself is in the integrity envelope (sidecar + SHA256SUMS +
#      attestation + release upload).
#   4. The expected-digest resolution honors BOXLITE_EXPECTED_SHA256 as the
#      strongest trust anchor for pinned installs, and emits a warning when
#      a pinned version falls back to the remote sidecar.
#
# Run from repo root:
#   sh scripts/release/test_install.sh
#
# Optional: set BOXLITE_INSTALL_TEMPLATE=<path> to validate an already-rendered
# install.sh (e.g. the freshly-rendered dist/install.sh in the release job)
# instead of re-rendering the template here with placeholder values.

set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
template="${repo_root}/scripts/release/install.sh.template"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ -n "${BOXLITE_INSTALL_TEMPLATE-}" ]; then
  # Validate a pre-rendered install.sh (the release job's dist/install.sh).
  cp "$BOXLITE_INSTALL_TEMPLATE" "$tmp/install.sh"
else
  # Render the template the way build-runtime.yml does, with fake values.
  sed \
    -e 's|__VERSION__|v0.0.0-test|g' \
    -e 's|__SHA_AARCH64_APPLE_DARWIN__|0000000000000000000000000000000000000000000000000000000000000000|g' \
    -e 's|__SHA_X86_64_UNKNOWN_LINUX_GNU__|0000000000000000000000000000000000000000000000000000000000000000|g' \
    -e 's|__SHA_AARCH64_UNKNOWN_LINUX_GNU__|0000000000000000000000000000000000000000000000000000000000000000|g' \
    "$template" > "$tmp/install.sh"
fi

# 1. Syntax-valid.
sh -n "$tmp/install.sh"

# 2. Placeholders fully substituted.
if grep -q '__VERSION__\|__SHA_' "$tmp/install.sh"; then
  echo "FAIL: rendered installer still has placeholders" >&2
  exit 1
fi

# 3. Atomic-replace pattern: stage inside install_dir, then `mv` over target.
#    Reject the in-place `install -m 0755 ... "${install_dir}/boxlite"`
#    pattern, which is non-atomic on Linux.
if grep -E 'install +-m +0755 +"[^"]*" +"\$\{install_dir\}/boxlite"' \
     "$tmp/install.sh" >/dev/null; then
  echo "FAIL: installer writes directly to \${install_dir}/boxlite" >&2
  echo "      Stage to a temp file in install_dir and 'mv -f' instead." >&2
  exit 1
fi

# Must stage to a hidden temp file inside install_dir.
if ! grep -E '"\$\{install_dir\}/\.boxlite\.tmp\.' "$tmp/install.sh" >/dev/null; then
  echo "FAIL: installer does not stage to \${install_dir}/.boxlite.tmp.*" >&2
  exit 1
fi

# Must use `mv -f` for the final swap (rename(2) on same filesystem is atomic).
if ! grep -E 'mv +-f +"\$staged" +"\$\{install_dir\}/boxlite"' \
       "$tmp/install.sh" >/dev/null; then
  echo "FAIL: installer does not 'mv -f \"\$staged\" \"\${install_dir}/boxlite\"'" >&2
  exit 1
fi

#-----------------------------------------------------------------------------
# Bootstrap-integrity assertions.
#
# The install.sh script itself is an executable asset users pipe into sh
# (`curl ... | sh`). If it is missing from the integrity envelope, any
# tampering of the wrapper bypasses every checksum it would later enforce
# on its payload. Cover three surfaces:
#   (a) the workflow produces install.sh.sha256 alongside the tarball sidecars
#   (b) SHA256SUMS lists install.sh
#   (c) attestation subject-path includes dist/install.sh
# (b) and (c) are structural YAML tests, not behavioral runs, because we
# cannot invoke actions/attest-build-provenance locally.
#-----------------------------------------------------------------------------
workflow="${repo_root}/.github/workflows/build-runtime.yml"

# (a) Sidecar generation is reachable: produce install.sh.sha256 from our
#     rendered install.sh the same way the workflow would, and verify it.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$tmp/install.sh" > "$tmp/install.sh.sha256"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$tmp" && shasum -a 256 install.sh) > "$tmp/install.sh.sha256"
else
  echo "FAIL: neither sha256sum nor shasum available" >&2
  exit 1
fi
[ -s "$tmp/install.sh.sha256" ] || {
  echo "FAIL: install.sh.sha256 was not produced" >&2
  exit 1
}

# Structural test: the workflow must produce install.sh.sha256 as part of
# the per-file sidecar step (either via glob or explicit invocation).
if ! grep -E 'install\.sh\.sha256|install\.sh"' "$workflow" >/dev/null; then
  echo "FAIL: build-runtime.yml does not generate install.sh.sha256" >&2
  exit 1
fi

# Structural test: SHA256SUMS step body must include install.sh as an arg
# to sha256sum. Use a strict block range that starts on the step header and
# ends on the NEXT step header (so the range covers the step's body).
if ! awk '
  /^      - name: Generate SHA256SUMS/ { in_block = 1; next }
  in_block && /^      - name: / { exit }
  in_block { print }
' "$workflow" | grep -E '(^| )install\.sh( |$)' >/dev/null; then
  echo "FAIL: SHA256SUMS step does not include install.sh" >&2
  exit 1
fi

# Structural test: attestation subject-path must include dist/install.sh.
if ! awk '
  /^      - name: Attest build provenance/ { in_block = 1; next }
  in_block && /^      - name: / { exit }
  in_block { print }
' "$workflow" | grep -E 'dist/install\.sh($|[^.])' >/dev/null; then
  echo "FAIL: attest-build-provenance subject-path does not include dist/install.sh" >&2
  exit 1
fi

# Structural test: release upload must ship install.sh.sha256 too, otherwise
# the sidecar exists in CI but never reaches the release page.
if ! awk '
  /^      - name: Upload to release/ { in_block = 1; next }
  in_block && /^      - name: / { exit }
  in_block { print }
' "$workflow" | grep -E 'dist/install\.sh\.sha256' >/dev/null; then
  echo "FAIL: release upload does not include dist/install.sh.sha256" >&2
  exit 1
fi

#-----------------------------------------------------------------------------
# Pinned-install trust-tier assertions.
#
# For pinned installs (BOXLITE_VERSION != CURRENT_VERSION) the embedded
# checksum is not authoritative for the requested version. The script must
# (a) honor BOXLITE_EXPECTED_SHA256 as the strongest anchor, and (b) warn
# when it falls back to the remote sidecar so the user knows they are
# trusting the release page itself (TLS only). Without (a), an attacker who
# can replace the tarball in an older release can replace the sidecar in
# the same release and the check is meaningless.
#-----------------------------------------------------------------------------

# (a) Caller-supplied digest is honored.
if ! grep -E 'BOXLITE_EXPECTED_SHA256' "$tmp/install.sh" >/dev/null; then
  echo "FAIL: installer does not honor BOXLITE_EXPECTED_SHA256" >&2
  echo "      Pinned installs need an out-of-band digest as an independent" >&2
  echo "      trust anchor; the remote .sha256 sidecar shares its trust root" >&2
  echo "      with the tarball." >&2
  exit 1
fi

# (b) The expected-digest resolution branches on BOXLITE_EXPECTED_SHA256
#     BEFORE the embedded/sidecar branches. If the conditional order is
#     wrong, the caller-supplied digest is silently ignored for the
#     current-version fast path.
if ! awk '
  /if \[ -n "\$\{BOXLITE_EXPECTED_SHA256-\}" \]/ { saw_caller = NR }
  /elif \[ "\$version" = "\$CURRENT_VERSION" \]/ { saw_current = NR }
  END {
    if (!saw_caller || !saw_current) exit 1
    if (saw_caller >= saw_current) exit 1
  }
' "$tmp/install.sh"; then
  echo "FAIL: BOXLITE_EXPECTED_SHA256 branch must precede the embedded/sidecar branches" >&2
  exit 1
fi

# (c) Pinned-without-digest path emits a warning that names BOXLITE_EXPECTED_SHA256.
#     The user must learn how to escape the weak tier from the message alone.
if ! grep -E 'warning:.*BOXLITE_VERSION|BOXLITE_EXPECTED_SHA256.*[Dd]igest|stronger guarantee' \
     "$tmp/install.sh" >/dev/null; then
  echo "FAIL: installer does not warn about weaker trust tier for pinned installs" >&2
  exit 1
fi

echo "OK: installer renders cleanly, uses atomic replace, is covered by integrity envelope, and honors BOXLITE_EXPECTED_SHA256 for pinned installs"
