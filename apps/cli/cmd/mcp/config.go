// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/spf13/cobra"
)

var ConfigCmd = &cobra.Command{
	Use:   "config [AGENT_NAME]",
	Short: "Outputs JSON configuration for BoxLite MCP Server",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return err
		}

		var mcpLogFilePath string

		switch runtime.GOOS {
		case "darwin":
			mcpLogFilePath = homeDir + "/.boxlite/boxlite-mcp.log"
		case "windows":
			mcpLogFilePath = os.Getenv("APPDATA") + "\\.boxlite\\boxlite-mcp.log"
		case "linux":
			mcpLogFilePath = homeDir + "/.boxlite/boxlite-mcp.log"
		default:
			return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
		}

		boxliteMcpConfig, err := getDayonaMcpConfig(mcpLogFilePath)
		if err != nil {
			return err
		}

		mcpConfig := map[string]interface{}{
			"boxlite-mcp": boxliteMcpConfig,
		}

		jsonBytes, err := json.MarshalIndent(mcpConfig, "", "  ")
		if err != nil {
			return err
		}

		fmt.Println(string(jsonBytes))

		return nil
	},
}

func getDayonaMcpConfig(mcpLogFilePath string) (map[string]interface{}, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	// Create boxlite-mcp config
	boxliteMcpConfig := map[string]interface{}{
		"command": "boxlite",
		"args":    []string{"mcp", "start"},
		"env": map[string]string{
			"PATH": homeDir + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
			"HOME": homeDir,
		},
		"logFile": mcpLogFilePath,
	}

	if runtime.GOOS == "windows" {
		boxliteMcpConfig["env"].(map[string]string)["APPDATA"] = os.Getenv("APPDATA")
	}

	return boxliteMcpConfig, nil
}
