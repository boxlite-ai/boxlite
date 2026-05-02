// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package organization

import (
	"context"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/config"
	"github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/organization"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/spf13/cobra"
)

var CreateCmd = &cobra.Command{
	Use:   "create [ORGANIZATION_NAME]",
	Short: "Create a new organization and set it as active",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient_cli.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		createOrganizationDto := apiclient.CreateOrganization{
			Name: args[0],
		}

		org, res, err := apiClient.OrganizationsAPI.CreateOrganization(ctx).CreateOrganization(createOrganizationDto).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		c, err := config.GetConfig()
		if err != nil {
			return err
		}

		activeProfile, err := c.GetActiveProfile()
		if err != nil {
			return err
		}

		activeProfile.ActiveOrganizationId = &org.Id
		err = c.EditProfile(activeProfile)
		if err != nil {
			return err
		}

		organization.RenderInfo(org, false)

		common.RenderInfoMessageBold("Your organization has been created and its approval is pending\nOur team has been notified and will set up your resource quotas shortly")
		return nil
	},
}
