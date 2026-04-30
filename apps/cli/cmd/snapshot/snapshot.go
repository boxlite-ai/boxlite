// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"github.com/boxlite-labs/boxlite/cli/internal"
	"github.com/spf13/cobra"
)

var SnapshotsCmd = &cobra.Command{
	Use:     "snapshot",
	Short:   "Manage BoxLite snapshots",
	Long:    "Commands for managing BoxLite snapshots",
	Aliases: []string{"snapshots"},
	GroupID: internal.SANDBOX_GROUP,
}

func init() {
	SnapshotsCmd.AddCommand(ListCmd)
	SnapshotsCmd.AddCommand(CreateCmd)
	SnapshotsCmd.AddCommand(PushCmd)
	SnapshotsCmd.AddCommand(DeleteCmd)
}
