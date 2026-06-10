// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"context"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/boxlite-ai/boxlite/cli/views/box"
	"github.com/spf13/cobra"
)

var InfoCmd = &cobra.Command{
	Use:     "info [BOX_ID] | [BOX_NAME]",
	Short:   "Get box info",
	Args:    cobra.ExactArgs(1),
	Aliases: common.GetAliases("info"),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		boxIdOrNameArg := args[0]

		sb, res, err := apiClient.BoxAPI.GetBox(ctx, boxIdOrNameArg).Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		if common.FormatFlag != "" {
			formattedData := common.NewFormatter(sb)
			formattedData.Print()
			return nil
		}

		box.RenderInfo(sb, false)

		return nil
	},
}

func init() {
	common.RegisterFormatFlag(InfoCmd)
}
