// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"context"
	"fmt"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/spf13/cobra"
)

var DeleteCmd = &cobra.Command{
	Use:     "delete [TEMPLATE_ID | TEMPLATE_NAME]",
	Short:   "Delete a template",
	Args:    cobra.MaximumNArgs(1),
	Aliases: common.GetAliases("delete"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		// Handle case when no template ID is provided and allFlag is true
		if len(args) == 0 {
			if allFlag {
				page := float32(1.0)
				limit := float32(200.0) // 200 is the maximum limit for the API
				var allTemplates []apiclient.BoxTemplateDto

				for {
					templateBatch, res, err := apiClient.TemplatesAPI.ListBoxTemplates(ctx).Page(page).Limit(limit).Execute()
					if err != nil {
						return apiclient_cli.HandleErrorResponse(res, err)
					}

					allTemplates = append(allTemplates, templateBatch...)

					if len(templateBatch) < int(limit) {
						break
					}
					page++
				}

				if len(allTemplates) == 0 {
					view_common.RenderInfoMessageBold("No templates to delete")
					return nil
				}

				var deletedCount int

				for _, template := range allTemplates {
					res, err := apiClient.TemplatesAPI.RemoveBoxTemplate(ctx, template.Id).Execute()
					if err != nil {
						fmt.Printf("Failed to delete template %s: %s\n", template.Id, apiclient_cli.HandleErrorResponse(res, err))
					} else {
						deletedCount++
					}
				}

				view_common.RenderInfoMessageBold(fmt.Sprintf("Deleted %d templates", deletedCount))
				return nil
			}
			return cmd.Help()
		}

		templateIdOrName := args[0]

		template, res, err := apiClient.TemplatesAPI.GetBoxTemplate(ctx, templateIdOrName).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		res, err = apiClient.TemplatesAPI.RemoveBoxTemplate(ctx, template.Id).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Template %s deleted", templateIdOrName))

		return nil
	},
}

var allFlag bool

func init() {
	DeleteCmd.Flags().BoolVarP(&allFlag, "all", "a", false, "Delete all templates")
}
