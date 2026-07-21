#!/usr/bin/env bash
# Bootstrap the local boxlite stack used by the e2e test suite.
#
# Idempotent: skips anything already set up; always regenerates the API
# env file (so new env vars added in a PR land on existing hosts) while
# preserving the secrets that must stay stable across restarts
# (ENCRYPTION_KEY/SALT — re-keying corrupts the DB; ADMIN_API_KEY — so
# the existing admin user keeps working).
#
# Designed for:
#   - Ubuntu 24+/26 host with /dev/kvm (nested KVM)
#   - sudo available
#
# NO AWS dependency: e2e tests exercise box lifecycle (create / exec /
# attach), which fetch images from docker.io into the local registry on
# 127.0.0.1:5000. The API's S3-backed VolumeManager early-returns when
# S3_ENDPOINT is empty (apps/api/src/box/managers/volume.manager.ts:47).
#
# Tear down with scripts/test/e2e/teardown.sh.

set -euo pipefail

# REPO autodetects via the script's own location — works regardless of
# where the user cloned to. The previous $HOME/ws/boxlite default broke
# every other layout.
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
APPS="$REPO/apps"
ENV_FILE="${ENV_FILE:-/etc/boxlite-api.env}"
SECRETS_FILE="${SECRETS_FILE:-/etc/boxlite-secrets.env}"

[[ -d "$REPO" ]] || { echo "REPO=$REPO not found"; exit 1; }
[[ -e /dev/kvm ]] || { echo "/dev/kvm missing — need nested-KVM host"; exit 1; }

echo "=== 1. apt: postgres, redis, openssl, docker, python3-pip ==="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    postgresql postgresql-contrib redis-server openssl docker.io \
    python3-pip ca-certificates curl
sudo systemctl enable --now postgresql redis-server docker

# Node.js 22 via NodeSource (ts-node + npx for the API service unit).
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE 'v(2[0-9]|[3-9][0-9])'; then
    echo "=== 1b. Node.js 22 (NodeSource) ==="
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi

# yarn via corepack (ships with Node 16+).
if ! command -v yarn >/dev/null 2>&1; then
    echo "=== 1c. yarn (via corepack) ==="
    sudo corepack enable
fi

# Docker registry — bound to 127.0.0.1 only. The registry is a local
# cache for snapshot pulls; no reason to expose it to the network.
if ! sudo docker ps --filter name=boxlite-registry --format '{{.Names}}' | grep -q boxlite-registry; then
    echo "=== 2. docker registry on 127.0.0.1:5000 ==="
    sudo docker run -d --name boxlite-registry --restart=always \
        -p 127.0.0.1:5000:5000 registry:2
fi
sudo usermod -aG docker "$USER" 2>/dev/null || true

echo "=== 3. postgres role/db (idempotent) ==="
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='boxlite'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER boxlite WITH PASSWORD 'boxlite' CREATEDB"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='boxlite_dev'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE boxlite_dev OWNER boxlite"

echo "=== 4. yarn install (stderr preserved — silent install hides real failures) ==="
# tslib + node-forge are in apps/package.json upstream; bootstrap no
# longer mutates the working tree to install them. The apps/apps self-
# symlink papers over project.json files using `apps/api/...` paths that
# assume workspace root is one level above apps/. The real fix is to
# rewrite those paths; that's a separate refactor PR.
cd "$APPS"
# yarn treats `apps/` as its own project root only when a lockfile anchors it;
# the repo doesn't commit one (see make/dev.mk), so seed an empty lockfile first
# or `yarn install` aborts with "apps isn't part of the project" on fresh checkouts.
[ -f yarn.lock ] || : > yarn.lock
yarn install >/dev/null
[[ -L "$APPS/apps" ]] || ln -sfn . apps

# ─── HOST_IP via IMDS — explicit warning if we're not on EC2 ────────────────
TOK=$(curl -sX PUT 'http://169.254.169.254/latest/api/token' \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null) || TOK=""
HOST_IP=$(curl -sH "X-aws-ec2-metadata-token: $TOK" \
    http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null) || HOST_IP=""
if [[ -z "$HOST_IP" ]]; then
    HOST_IP=127.0.0.1
    echo "WARNING: IMDS unreachable; defaulting RUNNER_DOMAIN to 127.0.0.1." >&2
    echo "  If the API/Runner need to be reached by another host, set" >&2
    echo "  the actual reachable IP via RUNNER_DOMAIN env." >&2
fi

# ─── 5. Stable secrets (gen once, persist across env-file rewrites) ────────
echo "=== 5. secrets (rotating these breaks the DB or invalidates admin login) ==="
if [[ -r "$SECRETS_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
elif sudo test -f "$SECRETS_FILE"; then
    # Legacy: was once written root-owned. Reclaim ownership.
    sudo chown "$USER:$USER" "$SECRETS_FILE"
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
else
    ENCRYPTION_KEY=$(openssl rand -hex 32)
    ENCRYPTION_SALT=$(openssl rand -hex 16)
    ADMIN_API_KEY=$(openssl rand -hex 24)
    PROXY_API_KEY=$(openssl rand -hex 16)
    SSH_GATEWAY_API_KEY=$(openssl rand -hex 16)
    DEFAULT_RUNNER_API_KEY=$(openssl rand -hex 16)
    sudo tee "$SECRETS_FILE" > /dev/null <<EOF
ENCRYPTION_KEY=$ENCRYPTION_KEY
ENCRYPTION_SALT=$ENCRYPTION_SALT
ADMIN_API_KEY=$ADMIN_API_KEY
PROXY_API_KEY=$PROXY_API_KEY
SSH_GATEWAY_API_KEY=$SSH_GATEWAY_API_KEY
DEFAULT_RUNNER_API_KEY=$DEFAULT_RUNNER_API_KEY
EOF
    # Owned by the user the API + fixture_setup run as, mode 600. The
    # tools that need to read it (boxlite-api.service, fixture_setup.py,
    # subsequent re-bootstrap) all run as $USER. Root can still read it
    # too; nobody else.
    sudo chown "$USER:$USER" "$SECRETS_FILE"
    sudo chmod 600 "$SECRETS_FILE"
fi

# ─── 6. Regenerate /etc/boxlite-api.env every bootstrap ─────────────────────
# Previous behaviour only wrote when missing, which meant new env vars
# added by a PR never landed on existing hosts. Now we always rewrite
# (preserving secrets via the secrets file).
#
# OIDC_ISSUER_BASE_URL is an HTTPS URL whose .well-known/openid-configuration
# we can fetch at startup. The API key auth path used by e2e bypasses
# the OIDC flow entirely — Google is just a known-fetchable issuer; no
# Google credentials needed.
echo "=== 6. write /etc/boxlite-api.env (always — preserves secrets, refreshes everything else) ==="
sudo tee "$ENV_FILE" > /dev/null <<EOF
NODE_ENV=development
PORT=3000
ENVIRONMENT=production
RUN_MIGRATIONS=true
VERSION=0.1.0
DEFAULT_REGION_ENFORCE_QUOTAS=false
DEFAULT_SNAPSHOT=ubuntu:22.04
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=boxlite
DB_PASSWORD=boxlite
DB_DATABASE=boxlite_dev
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_TLS=false
ENCRYPTION_KEY=$ENCRYPTION_KEY
ENCRYPTION_SALT=$ENCRYPTION_SALT
OIDC_CLIENT_ID=boxlite
OIDC_AUDIENCE=boxlite
OIDC_ISSUER_BASE_URL=https://accounts.google.com
S3_ENDPOINT=
S3_STS_ENDPOINT=
S3_REGION=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_DEFAULT_BUCKET=
S3_ACCOUNT_ID=
S3_ROLE_NAME=
PROXY_DOMAIN=localhost:3001
PROXY_PROTOCOL=http
PROXY_API_KEY=$PROXY_API_KEY
PROXY_TEMPLATE_URL=http://localhost:3001
SSH_GATEWAY_URL=ssh://localhost:2222
SSH_GATEWAY_API_KEY=$SSH_GATEWAY_API_KEY
ADMIN_API_KEY=$ADMIN_API_KEY
ADMIN_TOTAL_CPU_QUOTA=32
ADMIN_TOTAL_MEMORY_QUOTA=64
ADMIN_TOTAL_DISK_QUOTA=200
ADMIN_MAX_CPU_PER_BOX=8
ADMIN_MAX_MEMORY_PER_BOX=16
ADMIN_MAX_DISK_PER_BOX=50
ADMIN_SNAPSHOT_QUOTA=100
ADMIN_VOLUME_QUOTA=100
DASHBOARD_URL=http://localhost:5173
DASHBOARD_BASE_API_URL=http://localhost:3000
APP_URL=
TRANSIENT_REGISTRY_URL=http://localhost:5000
TRANSIENT_REGISTRY_ADMIN=admin
TRANSIENT_REGISTRY_PASSWORD=Harbor12345
TRANSIENT_REGISTRY_PROJECT_ID=boxlite
INTERNAL_REGISTRY_URL=http://localhost:5000
INTERNAL_REGISTRY_ADMIN=admin
INTERNAL_REGISTRY_PASSWORD=Harbor12345
INTERNAL_REGISTRY_PROJECT_ID=boxlite
INSECURE_REGISTRIES=localhost:5000
DEFAULT_RUNNER_NAME=default
DEFAULT_RUNNER_API_KEY=$DEFAULT_RUNNER_API_KEY
DEFAULT_RUNNER_DOMAIN=$HOST_IP
DEFAULT_RUNNER_API_URL=http://localhost:8080
DEFAULT_RUNNER_PROXY_URL=http://localhost:3001
DEFAULT_RUNNER_API_VERSION=2
AWS_REGION=us-east-1
VOLUME_BUCKET_PREFIX=boxlite-e2e-volume-
SKIP_CONNECTIONS=false
EOF
sudo chmod 644 "$ENV_FILE"

# ─── 7. boxlite-runner from working tree ────────────────────────────────────
echo "=== 7. boxlite-runner from current source ==="

# 7a. Rust toolchain via rustup. Don't pin a channel here — the repo's
# `rust-toolchain.toml` (channel = "stable") is rustup's source of truth.
# Forcing a default channel means rustup installs stable now and then
# the first `cargo` call ALSO installs whatever the toml says; one extra
# download for nothing.
if ! command -v cargo >/dev/null 2>&1; then
    echo "=== 7a. rustup (channel selection deferred to rust-toolchain.toml) ==="
    curl -fsSL https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
    . "$HOME/.cargo/env"
fi

# 7b. Go toolchain — version from apps/runner/go.mod. Install if
# missing OR if current Go is older than required.
# IMPORTANT: Go 1.21+ auto-downloads a matching toolchain when a go.mod
# requires a newer version (under ~/go/pkg/mod/golang.org/toolchain@...).
# That means `go version` reports the auto-toolchain version, not the
# system Go install — which is what `make setup:build` and any subprocess
# without GOTOOLCHAIN=local cares about. Use GOTOOLCHAIN=local + a
# directory without a go.mod to read the truthful system version.
GO_VER=$(awk '/^go [0-9]/ {print $2; exit}' "$REPO/apps/runner/go.mod" 2>/dev/null)
GO_VER=${GO_VER:-1.25.4}
GO_INSTALL=1
if command -v go >/dev/null 2>&1; then
    CUR_GO=$(cd /tmp && GOTOOLCHAIN=local go version 2>/dev/null | awk '{print $3}' | sed 's/^go//')
    if [[ -n "$CUR_GO" ]]; then
        # If the OLDEST of (cur, required) is `required`, then cur >= required → skip install
        OLDEST=$(printf '%s\n%s\n' "$CUR_GO" "$GO_VER" | sort -V | head -1)
        if [[ "$OLDEST" == "$GO_VER" ]]; then
            GO_INSTALL=0
        fi
    fi
fi
if [[ "$GO_INSTALL" == "1" ]]; then
    echo "=== 7b. install Go ${GO_VER} (from apps/runner/go.mod) ==="
    sudo rm -rf /usr/local/go
    curl -fsSL "https://go.dev/dl/go${GO_VER}.linux-amd64.tar.gz" \
        | sudo tar xz -C /usr/local/
    sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
    sudo ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    hash -r 2>/dev/null || true
fi

# 7c. C build-dependency stack + libboxlite.{a,so}.
# Fresh Ubuntu doesn't have meson / ninja / build-essential and the
# repo's bubblewrap-sys / e2fsprogs-sys / libkrun-sys crates all shell
# out to those during `cargo build`. `make setup:build` is the
# canonical installer (routes to scripts/setup/setup-ubuntu.sh).
# `make dist:c` then runs the C SDK release build AND stages the
# libraries to sdks/c/dist/lib/. Direct `cargo build -p boxlite-c`
# would skip the staging step that future tooling (e.g. fix-go-symbols)
# may rely on.
cd "$REPO"
echo "=== 7c. make setup:build (meson/ninja/build-essential/...) ==="
make setup:build

echo "=== 7d. make dist:c (libboxlite.a + .so) ==="
make dist:c
cp target/release/libboxlite.a sdks/go/libboxlite.a

cd "$REPO/apps/runner"
CGO_ENABLED=1 go build -o /tmp/boxlite-runner-build ./cmd/runner
sudo install -m 0755 /tmp/boxlite-runner-build /usr/local/bin/boxlite-runner
rm -f /tmp/boxlite-runner-build
cd "$REPO"
sudo mkdir -p /var/lib/boxlite
sudo chown "$USER:$USER" /var/lib/boxlite

# ─── 8. systemd units ───────────────────────────────────────────────────────
# API runs via npx ts-node intentionally:
#   - Production deploy uses webpack bundle; ts-node has minor differences
#     (TypeORM entity discovery) that don't affect any e2e-exercised path
#   - Webpack bundle adds 5-10 min to every PR run, not worth the parity
echo "=== 8. systemd units ==="
sudo tee /etc/systemd/system/boxlite-api.service > /dev/null <<UNIT
[Unit]
Description=BoxLite API (NestJS, ts-node dev mode)
After=network.target postgresql.service redis-server.service
Wants=postgresql.service redis-server.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APPS
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/npx ts-node --transpile-only --project api/tsconfig.app.json -r tsconfig-paths/register api/src/main.ts
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/boxlite-api.log
StandardError=append:/var/log/boxlite-api.log

[Install]
WantedBy=multi-user.target
UNIT
sudo touch /var/log/boxlite-api.log && sudo chown "$USER:$USER" /var/log/boxlite-api.log

sudo tee /etc/systemd/system/boxlite-runner.service > /dev/null <<UNIT
[Unit]
Description=BoxLite Runner
After=network.target boxlite-api.service

[Service]
Type=simple
User=$USER
EnvironmentFile=$ENV_FILE
ExecStart=/usr/local/bin/boxlite-runner
Restart=always
RestartSec=5
TimeoutStopSec=60
Environment=BOXLITE_API_URL=http://localhost:3000/api
Environment=BOXLITE_RUNNER_TOKEN=$DEFAULT_RUNNER_API_KEY
Environment=API_VERSION=2
Environment=API_PORT=8080
Environment=RUNNER_DOMAIN=$HOST_IP
Environment=BOXLITE_HOME_DIR=/var/lib/boxlite
Environment=AWS_REGION=us-east-1
Environment=INSECURE_REGISTRIES=localhost:5000

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload

# ─── 9. Start services + real health checks ────────────────────────────────
echo "=== 9. start services + verify they're answering ==="
sudo systemctl enable boxlite-api boxlite-runner 2>/dev/null
sudo systemctl restart boxlite-api

# API: poll /api/health until 200 OR 90s elapses.
api_ready=0
for i in $(seq 1 45); do
    if curl -fsS -o /dev/null http://localhost:3000/api/health; then
        api_ready=1; break
    fi
    sleep 2
done
if [[ $api_ready -ne 1 ]]; then
    echo "ERROR: boxlite-api did not answer /api/health within 90s" >&2
    sudo journalctl -u boxlite-api --no-pager -n 100 >&2
    exit 1
fi

sudo systemctl restart boxlite-runner
# Runner: poll the port AND verify it's the boxlite-runner process listening
# (not a stale process from a previous bootstrap).
runner_ready=0
for i in $(seq 1 30); do
    if pgrep -af '/usr/local/bin/boxlite-runner' >/dev/null \
       && ss -ltn 2>/dev/null | grep -q ':8080'; then
        runner_ready=1; break
    fi
    sleep 2
done
if [[ $runner_ready -ne 1 ]]; then
    echo "ERROR: boxlite-runner did not bind :8080 within 60s" >&2
    sudo journalctl -u boxlite-runner --no-pager -n 100 >&2
    exit 1
fi

# ─── 10. End-to-end smoke ───────────────────────────────────────────────────
# bootstrap "active" ≠ "real chain works". Probe /v1/me with the admin
# key — that exercises auth + DB + Redis end-to-end and surfaces broken
# secrets / DB migrations / encryption-key mismatch before the user
# runs the e2e suite.
echo "=== 10. end-to-end smoke (auth + DB) ==="
ME_JSON=$(curl -fsS -H "Authorization: Bearer $ADMIN_API_KEY" \
    http://localhost:3000/api/v1/me 2>&1 || echo "")
if ! echo "$ME_JSON" | grep -q '"sub"'; then
    echo "ERROR: smoke failed — /v1/me did not return a principal" >&2
    echo "  body: $ME_JSON" >&2
    # 401 specifically means the freshly-minted ADMIN_API_KEY doesn't
    # match the existing admin user's stored hash. That happens when
    # someone deleted $SECRETS_FILE without also dropping the DB. The
    # DB has the OLD admin user with the OLD key; the env has a NEW
    # key. Fix: scripts/test/e2e/teardown.sh --wipe-data + re-run.
    if echo "$ME_JSON" | grep -q 'error code: 401\|"statusCode":401\|HTTP 401'; then
        echo "" >&2
        echo "  HINT: 401 here usually means \$SECRETS_FILE was deleted" >&2
        echo "  but the DB still has an admin user from a previous mint." >&2
        echo "  Run: scripts/test/e2e/teardown.sh --wipe-data && re-run bootstrap" >&2
    fi
    exit 1
fi

echo ""
echo "=== bootstrap complete ==="
echo "api:    $(systemctl is-active boxlite-api)    :3000"
echo "runner: $(systemctl is-active boxlite-runner) :8080"
echo "admin api key:  $ADMIN_API_KEY    (also in $SECRETS_FILE)"
echo ""
echo "Next:  python3 scripts/test/e2e/fixture_setup.py"
