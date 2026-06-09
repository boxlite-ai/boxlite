// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"github.com/boxlite-ai/boxlite/cli/internal"
	"github.com/spf13/cobra"
)

var TemplatesCmd = &cobra.Command{
	Use:     "template",
	Short:   "Manage BoxLite templates",
	Long:    "Commands for managing BoxLite templates",
	Aliases: []string{"templates", "snapshot", "snapshots"},
	GroupID: internal.SANDBOX_GROUP,
}

func init() {
	TemplatesCmd.AddCommand(ListCmd)
	TemplatesCmd.AddCommand(CreateCmd)
	TemplatesCmd.AddCommand(PushCmd)
	TemplatesCmd.AddCommand(DeleteCmd)
}
