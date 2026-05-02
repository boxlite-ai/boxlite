// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package organization

import (
	"context"
	"fmt"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/boxlite-ai/boxlite/cli/config"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/organization"
	"github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/spf13/cobra"
)

var DeleteCmd = &cobra.Command{
	Use:     "delete [ORGANIZATION]",
	Short:   "Delete an organization",
	Args:    cobra.MaximumNArgs(1),
	Aliases: common.GetAliases("delete"),
	RunE: func(cmd *cobra.Command, args []string) error {
		var chosenOrganization *apiclient.Organization
		ctx := context.Background()

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		orgList, res, err := apiClient.OrganizationsAPI.ListOrganizations(ctx).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		if len(orgList) == 0 {
			util.NotifyEmptyOrganizationList(true)
			return nil
		}

		if len(args) == 0 {
			chosenOrganization, err = organization.GetOrganizationIdFromPrompt(orgList)
			if err != nil {
				return err
			}
		} else {
			for _, org := range orgList {
				if org.Id == args[0] || org.Name == args[0] {
					chosenOrganization = &org
					break
				}
			}

			if chosenOrganization == nil {
				return fmt.Errorf("organization %s not found", args[0])
			}
		}

		if chosenOrganization.Name == "Personal" {
			return fmt.Errorf("cannot delete personal organization")
		}

		res, err = apiClient.OrganizationsAPI.DeleteOrganization(ctx, chosenOrganization.Id).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Organization %s has been deleted", chosenOrganization.Name))

		c, err := config.GetConfig()
		if err != nil {
			return err
		}

		activeProfile, err := c.GetActiveProfile()
		if err != nil {
			return err
		}

		if activeProfile.ActiveOrganizationId == nil || *activeProfile.ActiveOrganizationId != chosenOrganization.Id {
			return nil
		}

		personalOrganizationId, err := common.GetPersonalOrganizationId(activeProfile)
		if err != nil {
			return err
		}

		activeProfile.ActiveOrganizationId = &personalOrganizationId
		return c.EditProfile(activeProfile)
	},
}
