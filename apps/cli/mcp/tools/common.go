// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package tools

import "github.com/boxlite-ai/boxlite/cli/apiclient"

var boxliteMCPHeaders map[string]string = map[string]string{
	apiclient.BoxliteSourceHeader: "boxlite-mcp",
}
