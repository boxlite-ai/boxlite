// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package sandbox

import (
	"github.com/boxlite-labs/boxlite/cli/internal"
	"github.com/spf13/cobra"
)

var SandboxCmd = &cobra.Command{
	Use:     "sandbox",
	Short:   "Manage BoxLite sandboxes",
	Long:    "Commands for managing BoxLite sandboxes",
	Aliases: []string{"sandboxes"},
	GroupID: internal.SANDBOX_GROUP,
	Hidden:  true, // Deprecated: use top-level commands instead (e.g., "boxlite start" instead of "boxlite sandbox start")
}

func init() {
	SandboxCmd.AddCommand(ListCmd)
	SandboxCmd.AddCommand(CreateCmd)
	SandboxCmd.AddCommand(InfoCmd)
	SandboxCmd.AddCommand(DeleteCmd)
	SandboxCmd.AddCommand(StartCmd)
	SandboxCmd.AddCommand(StopCmd)
	SandboxCmd.AddCommand(ArchiveCmd)
	SandboxCmd.AddCommand(SSHCmd)
	SandboxCmd.AddCommand(ExecCmd)
	SandboxCmd.AddCommand(PreviewUrlCmd)
}
