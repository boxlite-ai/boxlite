// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"context"
	"fmt"
	"time"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func AwaitBoxState(ctx context.Context, apiClient *apiclient.APIClient, targetBox string, state apiclient.BoxState) error {
	for {
		box, res, err := apiClient.BoxAPI.GetBox(ctx, targetBox).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		if box.State != nil && *box.State == state {
			return nil
		} else if box.State != nil && (*box.State == apiclient.BOXSTATE_ERROR || *box.State == apiclient.BOXSTATE_BUILD_FAILED) {
			if box.ErrorReason == nil {
				return fmt.Errorf("box processing failed")
			}
			return fmt.Errorf("box processing failed: %s", *box.ErrorReason)
		}

		time.Sleep(time.Second)
	}
}
