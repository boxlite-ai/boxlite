// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/boxlite-ai/boxlite/cli/apiclient"
	"github.com/mark3labs/mcp-go/mcp"

	log "github.com/sirupsen/logrus"
)

type DestroyBoxArgs struct {
	Id *string `json:"id,omitempty"`
}

func GetDestroyBoxTool() mcp.Tool {
	return mcp.NewTool("destroy_box",
		mcp.WithDescription("Destroy a box with BoxLite"),
		mcp.WithString("id", mcp.Required(), mcp.Description("ID of the box to destroy.")),
	)
}

func DestroyBox(ctx context.Context, request mcp.CallToolRequest, args DestroyBoxArgs) (*mcp.CallToolResult, error) {
	apiClient, err := apiclient.GetApiClient(nil, boxliteMCPHeaders)
	if err != nil {
		return &mcp.CallToolResult{IsError: true}, err
	}

	if args.Id == nil || *args.Id == "" {
		return &mcp.CallToolResult{IsError: true}, fmt.Errorf("box ID is required")
	}

	// Destroy box with retries
	maxRetries := 3
	retryDelay := time.Second * 2

	for retry := range maxRetries {
		_, _, err := apiClient.BoxAPI.DeleteBox(ctx, *args.Id).Execute()
		if err != nil {
			if retry == maxRetries-1 {
				return &mcp.CallToolResult{IsError: true}, fmt.Errorf("failed to destroy box after %d retries", maxRetries)
			}

			log.Infof("Box destroy request failed, retrying")

			time.Sleep(retryDelay)
			retryDelay = retryDelay * 3 / 2 // Exponential backoff
			continue
		}

		log.Infof("Destroyed box with ID: %s", *args.Id)

		return mcp.NewToolResultText(fmt.Sprintf("Destroyed box with ID %s", *args.Id)), nil
	}

	return &mcp.CallToolResult{IsError: true}, fmt.Errorf("failed to destroy box after %d retries", maxRetries)
}
