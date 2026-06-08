#!/bin/bash

# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: AGPL-3.0

# Fails if any migration file is placed directly under
# apps/api/src/migrations/ instead of pre-deploy/ or post-deploy/.
# Legacy migrations (timestamp <= LEGACY_CUTOFF) are excluded.

# Exit on error
set -e

LEGACY_CUTOFF=1770880371265

forbidden=()

for f in "$@"; do
  rel="${f#"$PWD"/}"
  rel="${rel#./}"
  migration_path="${rel#*src/migrations/}"

  if [ "$migration_path" = "$rel" ]; then
    continue
  fi

  case "$migration_path" in
    pre-deploy/*-migration.ts) ;;
    post-deploy/*-migration.ts) ;;
    */*-migration.ts)
      forbidden+=("$rel")
      ;;
    *-migration.ts)
      timestamp="${migration_path%%-*}"
      if [[ "$timestamp" =~ ^[0-9]+$ ]] && [ "$timestamp" -le "$LEGACY_CUTOFF" ]; then
        continue
      fi
      forbidden+=("$rel")
      ;;
  esac
done

if [ ${#forbidden[@]} -gt 0 ]; then
  echo "Migration files must be placed in one of:" >&2
  echo "  - apps/api/src/migrations/pre-deploy/" >&2
  echo "  - apps/api/src/migrations/post-deploy/" >&2
  echo "" >&2
  echo "Invalid paths:" >&2
  for p in "${forbidden[@]}"; do
    echo "  - $p" >&2
  done
  echo "" >&2
  echo "See apps/api/src/migrations/README.md for more information." >&2
  exit 1
fi
