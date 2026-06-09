// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"context"
	"fmt"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/spf13/cobra"
)

var forceFlag bool

var StopCmd = &cobra.Command{
	Use:   "stop [BOX_ID] | [BOX_NAME]",
	Short: "Stop a box",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		boxIdOrNameArg := args[0]

		req := apiClient.BoxAPI.StopBox(ctx, boxIdOrNameArg)
		if forceFlag {
			req = req.Force(forceFlag)
		}
		_, res, err := req.Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Box %s stopped", boxIdOrNameArg))
		return nil
	},
}

func init() {
	StopCmd.Flags().BoolVarP(&forceFlag, "force", "f", false, "Force stop the box using SIGKILL")
}
