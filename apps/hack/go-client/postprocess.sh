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

# encoding/json accepts null for slices, so preserve the OpenAPI non-null
# contract for LinuxCapabilities' required array fields after regeneration.
CAPABILITIES_MODEL="$PROJECT_ROOT/model_linux_capabilities.go"
REQUIRED_VALUE_CHECK='if _, exists := allProperties[requiredProperty]; !exists {'
NULL_SAFE_REQUIRED_VALUE_CHECK='if value, exists := allProperties[requiredProperty]; !exists || value == nil {'

if [ "$(grep -Fc "$REQUIRED_VALUE_CHECK" "$CAPABILITIES_MODEL")" -ne 1 ]; then
  echo "ERROR: LinuxCapabilities required-value check not found exactly once" >&2
  exit 1
fi
sed -i 's/if _, exists := allProperties\[requiredProperty\]; !exists {/if value, exists := allProperties[requiredProperty]; !exists || value == nil {/' "$CAPABILITIES_MODEL"
grep -Fq "$NULL_SAFE_REQUIRED_VALUE_CHECK" "$CAPABILITIES_MODEL" || { echo "ERROR: LinuxCapabilities null guard was not applied" >&2; exit 1; }

echo "Postprocessed Go client at $PROJECT_ROOT"
