#!/usr/bin/env bash
set -euo pipefail

# Adds dynamic version (go:embed) and custom UserAgent to generated Go API clients.
# Usage: postprocess.sh <project-root> <package-name> <client-name>

if [ $# -lt 3 ]; then
  echo "Usage: $0 <project-root> <package-name> <client-name>" >&2
  exit 1
fi

PROJECT_ROOT="$1"
PACKAGE_NAME="$2"
CLIENT_NAME="$3"

cat > "$PROJECT_ROOT/version.go" << EOF
package ${PACKAGE_NAME}

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var _clientVersion string

var ClientVersion = strings.TrimSpace(_clientVersion)
EOF

grep -q 'UserAgent:.*"[^"]*"' "$PROJECT_ROOT/configuration.go" || { echo "ERROR: UserAgent string not found in configuration.go" >&2; exit 1; }
sed -i "s|UserAgent: *\"[^\"]*\"|UserAgent:        \"${CLIENT_NAME}/\" + ClientVersion|" "$PROJECT_ROOT/configuration.go"

# openapi-generator's own go.mod template only knows about its generated
# *.go files, so it always emits a fixed boilerplate go.mod/go.sum -- any
# hand-written package living in this same module (e.g. sshcredential/,
# which imports golang.org/x/crypto/ssh) needs `go mod tidy` to recover
# real requires, or every regen (including CI's drift check) silently
# reverts them.
(cd "$PROJECT_ROOT" && go mod tidy)

echo "Postprocessed Go client at $PROJECT_ROOT"
