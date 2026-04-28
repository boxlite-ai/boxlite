// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package mcp

import (
	"github.com/spf13/cobra"
)

var MCPCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Manage BoxLite MCP Server",
	Long:  "Commands for managing BoxLite MCP Server",
}

func init() {
	MCPCmd.AddCommand(InitCmd)
	MCPCmd.AddCommand(StartCmd)
	MCPCmd.AddCommand(ConfigCmd)
}
