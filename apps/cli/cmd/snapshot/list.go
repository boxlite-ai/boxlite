// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"context"
	"fmt"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/boxlite-ai/boxlite/cli/config"
	templateView "github.com/boxlite-ai/boxlite/cli/views/snapshot"
	"github.com/spf13/cobra"
)

var (
	pageFlag  int
	limitFlag int
)

var ListCmd = &cobra.Command{
	Use:     "list",
	Short:   "List all templates",
	Long:    "List all available BoxLite templates",
	Aliases: common.GetAliases("list"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		page := float32(1.0)
		limit := float32(100.0)

		if cmd.Flags().Changed("page") {
			page = float32(pageFlag)
		}

		if cmd.Flags().Changed("limit") {
			limit = float32(limitFlag)
		}

		listTemplatesRequest := apiClient.TemplatesAPI.ListBoxTemplates(ctx)
		if cmd.Flags().Changed("page") {
			listTemplatesRequest = listTemplatesRequest.Page(page)
		}
		if cmd.Flags().Changed("limit") {
			listTemplatesRequest = listTemplatesRequest.Limit(limit)
		}

		templates, res, err := listTemplatesRequest.Execute()
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			return apiclient.HandleErrorResponse(res, err)
		}

		if common.FormatFlag != "" {
			formattedData := common.NewFormatter(templates)
			formattedData.Print()
			return nil
		}

		var activeOrganizationName *string

		if !config.IsApiKeyAuth() {
			name, err := common.GetActiveOrganizationName(apiClient, ctx)
			if err != nil {
				return err
			}
			activeOrganizationName = &name
		}

		templateView.ListTemplates(templates, activeOrganizationName)
		return nil
	},
}

func init() {
	common.RegisterFormatFlag(ListCmd)
	ListCmd.Flags().IntVarP(&pageFlag, "page", "p", 1, "Page number for pagination (starting from 1)")
	ListCmd.Flags().IntVarP(&limitFlag, "limit", "l", 100, "Maximum number of items per page")
}
