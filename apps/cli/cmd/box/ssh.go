// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"context"
	"fmt"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/boxlite-ai/boxlite/cli/cmd/common"
	"github.com/spf13/cobra"
)

var SSHCmd = &cobra.Command{
	Use:   "ssh [BOX_ID] | [BOX_NAME]",
	Short: "SSH into a box",
	Long:  "Establish an SSH connection to a running box",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		ctx := context.Background()

		apiClient, err := apiclient.GetApiClient(nil, nil)
		if err != nil {
			return err
		}

		boxIdOrName := args[0]

		// Get box to check state
		box, res, err := apiClient.BoxAPI.GetBox(ctx, boxIdOrName).Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		if err := common.RequireStartedState(box); err != nil {
			return err
		}

		// Create SSH access token
		sshAccessRequest := apiClient.BoxAPI.CreateSshAccess(ctx, box.Id)
		if sshExpiresInMinutes > 0 {
			sshAccessRequest = sshAccessRequest.ExpiresInMinutes(float32(sshExpiresInMinutes))
		}

		sshAccess, res, err := sshAccessRequest.Execute()
		if err != nil {
			return apiclient.HandleErrorResponse(res, err)
		}

		// Parse the SSH command from the response
		sshArgs, err := common.ParseSSHCommand(sshAccess.SshCommand)
		if err != nil {
			return fmt.Errorf("failed to parse SSH command: %w", err)
		}

		// Execute SSH
		return common.ExecuteSSH(sshArgs)
	},
}

var sshExpiresInMinutes int

func init() {
	SSHCmd.Flags().IntVar(&sshExpiresInMinutes, "expires", 1440, "SSH access token expiration time in minutes (defaults to 24 hours)")
}
