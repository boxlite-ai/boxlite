// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package sandbox

import (
	"context"
	"fmt"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	view_common "github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/spf13/cobra"
)

var StartCmd = &cobra.Command{
	Use:   "start [SANDBOX_ID] | [SANDBOX_NAME]",
	Short: "Start a sandbox",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		sandboxIdOrNameArg := args[0]

		_, res, err := apiClient.SandboxAPI.StartSandbox(ctx, sandboxIdOrNameArg).Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		view_common.RenderInfoMessageBold(fmt.Sprintf("Sandbox %s started", sandboxIdOrNameArg))

		return nil
	},
}

func init() {
}
