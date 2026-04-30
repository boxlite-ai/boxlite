// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package sandbox

import (
	"context"
	"fmt"

	"github.com/boxlite-labs/boxlite/cli/apiclient"
	view_common "github.com/boxlite-labs/boxlite/cli/views/common"
	"github.com/spf13/cobra"
)

var forceFlag bool

var StopCmd = &cobra.Command{
	Use:   "stop [SANDBOX_ID] | [SANDBOX_NAME]",
	Short: "Stop a sandbox",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		sandboxIdOrNameArg := args[0]

		req := apiClient.SandboxAPI.StopSandbox(ctx, sandboxIdOrNameArg)
		if forceFlag {
			req = req.Force(forceFlag)
		}
		_, res, err := req.Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Sandbox %s stopped", sandboxIdOrNameArg))
		return nil
	},
}

func init() {
	StopCmd.Flags().BoolVarP(&forceFlag, "force", "f", false, "Force stop the sandbox using SIGKILL")
}
