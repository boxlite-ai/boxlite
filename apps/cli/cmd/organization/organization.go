// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package organization

import (
	"errors"

	"github.com/boxlite-ai/boxlite/cli/config"
	"github.com/boxlite-ai/boxlite/cli/internal"
	"github.com/spf13/cobra"
)

var OrganizationCmd = &cobra.Command{
	Use:     "organization",
	Short:   "Manage BoxLite organizations",
	Long:    "Commands for managing BoxLite organizations",
	Aliases: []string{"organizations", "org", "orgs"},
	GroupID: internal.USER_GROUP,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if config.IsApiKeyAuth() {
			return errors.New("organization commands are not available when using API key authentication - run `boxlite login` to reauthenticate with browser")
		}

		return nil
	},
}

func init() {
	OrganizationCmd.AddCommand(ListCmd)
	OrganizationCmd.AddCommand(CreateCmd)
	OrganizationCmd.AddCommand(UseCmd)
	OrganizationCmd.AddCommand(DeleteCmd)
}
