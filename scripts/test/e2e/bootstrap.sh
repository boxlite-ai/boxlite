#!/usr/bin/env bash
# Bootstrap the local boxlite stack used by the e2e test suite.
#
# Idempotent: skips anything that's already set up. Designed for:
#   - Ubuntu 24+/26 host with /dev/kvm (nested KVM)
#   - sudo available
#   - Repo at REPO (default $HOME/ws/boxlite)
#
# NO AWS dependency: the e2e tests exercise box lifecycle (create / exec /
# attach / lifecycle), which fetch images from docker.io into the local
# docker registry on :5000 and run libkrun VMs against local qcow2. The
# API's S3-backed VolumeManager / ObjectStorageService are disabled by
# setting S3_ENDPOINT="" — that path early-returns at construction time
# (see apps/api/src/sandbox/managers/volume.manager.ts).
#
# Sets up but does NOT run the e2e fixture data (snapshots, quotas, p1
# profile) — that's `fixture_setup.py`, which runs after the API is up.

set -euo pipefail

REPO="${REPO:-$HOME/ws/boxlite}"
APPS="$REPO/apps"
ENV_FILE="${ENV_FILE:-/etc/boxlite-api.env}"

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

if false; then    # mount-s3 only matters for volume mounting which e2e doesn't test
    echo "=== mountpoint-s3 (skipped — e2e doesn't use volumes) ==="
    curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/1.20.0/x86_64/mount-s3-1.20.0-x86_64.deb" \
        -o /tmp/mount-s3.deb
    sudo apt-get install -y -qq /tmp/mount-s3.deb
    rm -f /tmp/mount-s3.deb
fi

if ! sudo docker ps --filter name=boxlite-registry --format '{{.Names}}' | grep -q boxlite-registry; then
    echo "=== 4. docker registry :5000 ==="
    sudo docker run -d --name boxlite-registry --restart=always -p 5000:5000 registry:2
fi
sudo usermod -aG docker "$USER" 2>/dev/null || true

echo "=== 5. postgres role/db (idempotent) ==="
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='boxlite'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER boxlite WITH PASSWORD 'boxlite' CREATEDB"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='boxlite_dev'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE boxlite_dev OWNER boxlite"

echo "=== 6. yarn install + apps/apps self-symlink + missing deps ==="
cd "$APPS"
yarn install >/dev/null 2>&1
[[ -L "$APPS/apps" ]] || ln -sfn . apps   # api/project.json uses apps/api/* paths
yarn add tslib node-forge >/dev/null 2>&1 || true

echo "=== 7. /etc/boxlite-api.env ==="
TOK=$(curl -sX PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null) || TOK=""
HOST_IP=$(curl -sH "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null) || HOST_IP=127.0.0.1

if [[ ! -f "$ENV_FILE" ]]; then
    ENCRYPTION_KEY=$(openssl rand -hex 32)
    ENCRYPTION_SALT=$(openssl rand -hex 16)
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
PROXY_API_KEY=proxy-devkey
PROXY_TEMPLATE_URL=http://localhost:3001
SSH_GATEWAY_URL=ssh://localhost:2222
SSH_GATEWAY_API_KEY=ssh-gateway-devkey
ADMIN_API_KEY=devkey
ADMIN_TOTAL_CPU_QUOTA=32
ADMIN_TOTAL_MEMORY_QUOTA=64
ADMIN_TOTAL_DISK_QUOTA=200
ADMIN_MAX_CPU_PER_SANDBOX=8
ADMIN_MAX_MEMORY_PER_SANDBOX=16
ADMIN_MAX_DISK_PER_SANDBOX=50
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
DEFAULT_RUNNER_API_KEY=runner-devkey
DEFAULT_RUNNER_DOMAIN=$HOST_IP
DEFAULT_RUNNER_API_URL=http://localhost:8080
DEFAULT_RUNNER_PROXY_URL=http://localhost:3001
DEFAULT_RUNNER_API_VERSION=2
AWS_REGION=us-east-1
SKIP_CONNECTIONS=false
EOF
    sudo chmod 644 "$ENV_FILE"
fi

echo "=== 8. boxlite-runner from current source ==="
# Build runner from the working tree — release pin would test stale
# code instead of whatever the PR is changing. See PR #678 review.
if ! command -v cargo >/dev/null 2>&1; then
    echo "=== 8a. Rust toolchain (rustup) ==="
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    . "$HOME/.cargo/env"
fi
if ! command -v go >/dev/null 2>&1; then
    echo "=== 8b. Go toolchain ==="
    GO_VER=1.23.4
    curl -fsSL "https://go.dev/dl/go${GO_VER}.linux-amd64.tar.gz" \
        | sudo tar xz -C /usr/local/
    sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
    sudo ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
fi

# C SDK static lib (boxlite-runner CGOs into libboxlite.a).
cd "$REPO"
cargo build --release -p boxlite-c
cp target/release/libboxlite.a sdks/go/libboxlite.a

# Go runner binary.
cd "$REPO/apps/runner"
CGO_ENABLED=1 go build -o /tmp/boxlite-runner-build ./cmd/runner
sudo install -m 0755 /tmp/boxlite-runner-build /usr/local/bin/boxlite-runner
rm -f /tmp/boxlite-runner-build
cd "$REPO"
sudo mkdir -p /var/lib/boxlite
sudo chown "$USER:$USER" /var/lib/boxlite

echo "=== 9. systemd units ==="
sudo tee /etc/systemd/system/boxlite-api.service > /dev/null <<UNIT
[Unit]
Description=BoxLite API (NestJS, ts-node local-dev mode)
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
ExecStart=/usr/local/bin/boxlite-runner
Restart=always
RestartSec=5
TimeoutStopSec=60
Environment=BOXLITE_API_URL=http://localhost:3000/api
Environment=BOXLITE_RUNNER_TOKEN=runner-devkey
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

echo "=== 10. start services ==="
sudo systemctl enable boxlite-api boxlite-runner 2>/dev/null
sudo systemctl restart boxlite-api
for i in $(seq 1 60); do
    curl -fsS http://localhost:3000/api/health >/dev/null 2>&1 && break
    sleep 2
done
sudo systemctl restart boxlite-runner
sleep 3

echo ""
echo "=== bootstrap complete ==="
echo "api:    $(systemctl is-active boxlite-api)    :3000"
echo "runner: $(systemctl is-active boxlite-runner) :8080"
echo ""
echo "Next:  python3 scripts/test/e2e/fixture_setup.py"
