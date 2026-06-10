#!/bin/bash
# Copyright 2025 Daytona Platforms Inc.
# SPDX-License-Identifier: AGPL-3.0


# Clean up existing documentation files
rm -rf docs hack/docs

# Generate default CLI documentation files in folder "docs"
go run main.go generate-docs

# Match the repo's committed formatting (same as the daemon docs target)
../node_modules/.bin/prettier --write "hack/docs/**/*.yaml"
