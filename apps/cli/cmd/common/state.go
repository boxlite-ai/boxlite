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

func AwaitBoxTemplateState(ctx context.Context, apiClient *apiclient.APIClient, name string, state apiclient.BoxTemplateState) error {
	for {
		template, res, err := apiClient.TemplatesAPI.GetBoxTemplate(ctx, name).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		switch template.State {
		case state:
			return nil
		case apiclient.BOXTEMPLATESTATE_ERROR, apiclient.BOXTEMPLATESTATE_BUILD_FAILED:
			if template.ErrorReason == nil {
				return fmt.Errorf("template processing failed")
			}
			return fmt.Errorf("template processing failed: %s", *template.ErrorReason)
		}

		time.Sleep(time.Second)
	}
}

func AwaitSandboxState(ctx context.Context, apiClient *apiclient.APIClient, targetSandbox string, state apiclient.SandboxState) error {
	for {
		sandbox, res, err := apiClient.SandboxAPI.GetSandbox(ctx, targetSandbox).Execute()
		if err != nil {
			return apiclient_cli.HandleErrorResponse(res, err)
		}

		if sandbox.State != nil && *sandbox.State == state {
			return nil
		} else if sandbox.State != nil && (*sandbox.State == apiclient.SANDBOXSTATE_ERROR || *sandbox.State == apiclient.SANDBOXSTATE_BUILD_FAILED) {
			if sandbox.ErrorReason == nil {
				return fmt.Errorf("sandbox processing failed")
			}
			return fmt.Errorf("sandbox processing failed: %s", *sandbox.ErrorReason)
		}

		time.Sleep(time.Second)
	}
}
