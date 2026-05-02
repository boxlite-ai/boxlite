// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package organization

import (
	"github.com/boxlite-ai/boxlite/cli/views/common"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/charmbracelet/huh"
)

func GetOrganizationIdFromPrompt(organizationList []apiclient.Organization) (*apiclient.Organization, error) {
	var chosenOrganizationId string
	var organizationOptions []huh.Option[string]

	for _, organization := range organizationList {
		organizationOptions = append(organizationOptions, huh.NewOption(organization.Name, organization.Id))
	}

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Choose an Organization").
				Options(
					organizationOptions...,
				).
				Value(&chosenOrganizationId),
		).WithTheme(common.GetCustomTheme()),
	)

	if err := form.Run(); err != nil {
		return nil, err
	}

	for _, organization := range organizationList {
		if organization.Id == chosenOrganizationId {
			return &organization, nil
		}
	}

	return nil, nil
}
