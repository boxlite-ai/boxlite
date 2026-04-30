// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package mcp

import (
	"os"
	"os/signal"

	"github.com/boxlite-labs/boxlite/cli/mcp"
	"github.com/spf13/cobra"
)

var StartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start BoxLite MCP Server",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		server := mcp.NewBoxliteMCPServer()

		interruptChan := make(chan os.Signal, 1)
		signal.Notify(interruptChan, os.Interrupt)

		errChan := make(chan error)

		go func() {
			errChan <- server.Start()
		}()

		select {
		case err := <-errChan:
			return err
		case <-interruptChan:
			return nil
		}
	},
}
