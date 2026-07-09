#!/usr/bin/env bash
# Build a throwaway fixture repo that exercises every filesystem path the
# runner deploy scripts touch, plus a PATH shim dir that records the semantic
# commands (build/publish/SSM) each implementation issues. The parity test
# runs the bash and JS implementations against the same fixture and diffs the
# recorded call logs — text utilities (sed/awk/grep/base64/sha256sum) are NOT
# recorded because the JS twin legitimately replaces them with node builtins.
#
# Usage: setup-fixture.sh <fixture-root>
set -euo pipefail

FIXTURE="${1:?usage: setup-fixture.sh <fixture-root>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

mkdir -p "$FIXTURE"/{apps/runner,apps/common-go,apps/api-client-go,scripts/build,scripts/deploy,sdks/go,target/release,dist}

cat > "$FIXTURE/Cargo.toml" <<'EOF'
[package]
name = "boxlite"
version = "0.9.7"
EOF

cat > "$FIXTURE/apps/runner/go.mod" <<'EOF'
module github.com/boxlite-ai/runner

go 1.24
EOF

# The real build scripts under test, copied so ROOT_DIR resolution inside them
# lands on the fixture instead of the actual repo.
cp "$REPO_ROOT/scripts/deploy/build-runner-binary.sh" "$FIXTURE/scripts/deploy/"
if [ -f "$REPO_ROOT/scripts/deploy/build-runner-binary.mjs" ]; then
  cp "$REPO_ROOT/scripts/deploy/build-runner-binary.mjs" "$FIXTURE/scripts/deploy/"
fi
cp "$REPO_ROOT/scripts/deploy/runner-update-binary.sh" "$FIXTURE/scripts/deploy/"
if [ -f "$REPO_ROOT/scripts/deploy/runner-update-binary.mjs" ]; then
  cp "$REPO_ROOT/scripts/deploy/runner-update-binary.mjs" "$FIXTURE/scripts/deploy/"
fi

# Product build steps the deploy script shells out to. They log themselves and
# regenerate the inputs the deploy script cleaned beforehand.
cat > "$FIXTURE/scripts/build/build-shim.sh" <<'EOF'
#!/usr/bin/env bash
echo "build-shim.sh $*" >> "$CALL_LOG"
mkdir -p "$FIXTURE_ROOT/target/release"
printf 'shim-binary-v1' > "$FIXTURE_ROOT/target/release/boxlite-shim"
chmod +x "$FIXTURE_ROOT/target/release/boxlite-shim"
EOF

cat > "$FIXTURE/scripts/build/build-guest.sh" <<'EOF'
#!/usr/bin/env bash
echo "build-guest.sh $*" >> "$CALL_LOG"
mkdir -p "$FIXTURE_ROOT/target/x86_64-unknown-linux-musl/release"
printf 'guest-binary-v1' > "$FIXTURE_ROOT/target/x86_64-unknown-linux-musl/release/boxlite-guest"
chmod +x "$FIXTURE_ROOT/target/x86_64-unknown-linux-musl/release/boxlite-guest"
EOF

cat > "$FIXTURE/scripts/build/fix-go-symbols.sh" <<'EOF'
#!/usr/bin/env bash
echo "fix-go-symbols.sh $*" >> "$CALL_LOG"
test -f "${1:?lib path required}"
EOF

chmod +x "$FIXTURE"/scripts/build/*.sh "$FIXTURE"/scripts/deploy/*.sh
[ -f "$FIXTURE/scripts/deploy/build-runner-binary.mjs" ] && chmod +x "$FIXTURE"/scripts/deploy/*.mjs

# ── PATH shims ──────────────────────────────────────────────────────────────
SHIMS="$FIXTURE/shims"
mkdir -p "$SHIMS"

logged_shim() { # name [extra-body...]
  local name="$1"; shift
  {
    echo '#!/usr/bin/env bash'
    echo "echo \"$name \$*\" >> \"\$CALL_LOG\""
    printf '%s\n' "$@"
  } > "$SHIMS/$name"
  chmod +x "$SHIMS/$name"
}

quiet_shim() { # name body...
  local name="$1"; shift
  {
    echo '#!/usr/bin/env bash'
    printf '%s\n' "$@"
  } > "$SHIMS/$name"
  chmod +x "$SHIMS/$name"
}

logged_shim cargo ':'
logged_shim make '
if [ "${1:-}" = "dist:c" ]; then
  mkdir -p "$FIXTURE_ROOT/target/release/build/boxlite-fixture123/out/runtime"
  cp "$FIXTURE_ROOT/target/x86_64-unknown-linux-musl/release/boxlite-guest" \
     "$FIXTURE_ROOT/target/release/build/boxlite-fixture123/out/runtime/boxlite-guest"
  printf 'lib-v1' > "$FIXTURE_ROOT/target/release/libboxlite.a"
fi'
logged_shim go '
prev=""
out=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
if [ -n "$out" ]; then
  printf 'runner-binary-v1' > "$out"
  chmod +x "$out"
fi'
logged_shim git '
if [ "$1 $2" = "rev-parse --short" ]; then echo abc1234; fi'
logged_shim tar 'exec /usr/bin/tar "$@"'
logged_shim curl ':'
logged_shim aws '
query=""
s3uri=""
prev=""
for a in "$@"; do
  [ "$prev" = "--query" ] && query="$a"
  case "$a" in s3://*) s3uri="$a" ;; esac
  prev="$a"
done
case "$1 ${2:-}" in
  "s3 presign") echo "https://presigned.example/${s3uri#s3://}" ;;
  "s3 cp") : ;;
  "sts get-caller-identity") echo 111122223333 ;;
  "ssm send-command") echo cmd-fixture-0001 ;;
  "ssm get-command-invocation")
    case "$query" in
      Status) echo Success ;;
      StandardOutputContent) echo remote-ok ;;
      StandardErrorContent) echo "" ;;
      *) echo Success ;;
    esac
    ;;
esac'

quiet_shim uname 'case "${1:-}" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac'
quiet_shim sha256sum 'exec /usr/bin/shasum -a 256 "$@"'
quiet_shim sleep ':'

echo "fixture ready: $FIXTURE"
