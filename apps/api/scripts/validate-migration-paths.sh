#!/bin/bash

# Copyright Daytona Platforms Inc.
# SPDX-License-Identifier: AGPL-3.0

# Check placement and the suffix used by the API build and migration loaders.
# Legacy migrations (timestamp <= LEGACY_CUTOFF) may stay at the root.

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
    pre-deploy/*/*-migration.ts|post-deploy/*/*-migration.ts)
      forbidden+=("$rel")
      ;;
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
    *.spec.ts) ;;
    [0-9]*.ts|*/[0-9]*.ts)
      forbidden+=("$rel")
      ;;
  esac
done

if [ ${#forbidden[@]} -gt 0 ]; then
  echo "Use the -migration.ts suffix and place migration files in one of:" >&2
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
