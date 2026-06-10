// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"github.com/boxlite-ai/boxlite/cli/internal"
	"github.com/spf13/cobra"
)

var BoxCmd = &cobra.Command{
	Use:     "box",
	Short:   "Manage BoxLite boxes",
	Long:    "Commands for managing BoxLite boxes",
	Aliases: []string{"boxes"},
	GroupID: internal.BOX_GROUP,
	Hidden:  true, // Deprecated: use top-level commands instead (e.g., "boxlite start" instead of "boxlite box start")
}

func init() {
	BoxCmd.AddCommand(ListCmd)
	BoxCmd.AddCommand(CreateCmd)
	BoxCmd.AddCommand(InfoCmd)
	BoxCmd.AddCommand(DeleteCmd)
	BoxCmd.AddCommand(StartCmd)
	BoxCmd.AddCommand(StopCmd)
	BoxCmd.AddCommand(SSHCmd)
	BoxCmd.AddCommand(ExecCmd)
	BoxCmd.AddCommand(PreviewUrlCmd)
}
