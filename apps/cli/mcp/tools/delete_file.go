// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package tools

import (
	"context"
	"fmt"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/mark3labs/mcp-go/mcp"

	log "github.com/sirupsen/logrus"
)

type DeleteFileArgs struct {
	Id       *string `json:"id,omitempty"`
	FilePath *string `json:"filePath,omitempty"`
}

func GetDeleteFileTool() mcp.Tool {
	return mcp.NewTool("delete_file",
		mcp.WithDescription("Delete a file or directory in the BoxLite sandbox."),
		mcp.WithString("filePath", mcp.Required(), mcp.Description("Path to the file or directory to delete.")),
		mcp.WithString("id", mcp.Required(), mcp.Description("ID of the sandbox to delete the file in.")),
	)
}

func DeleteFile(ctx context.Context, request mcp.CallToolRequest, args DeleteFileArgs) (*mcp.CallToolResult, error) {
	apiClient, err := apiclient_cli.GetApiClient(nil, boxliteMCPHeaders)
	if err != nil {
		return &mcp.CallToolResult{IsError: true}, err
	}

	if args.Id == nil || *args.Id == "" {
		return &mcp.CallToolResult{IsError: true}, fmt.Errorf("sandbox ID is required")
	}

	if args.FilePath == nil || *args.FilePath == "" {
		return &mcp.CallToolResult{IsError: true}, fmt.Errorf("filePath parameter is required")
	}

	// Execute delete command
	execResponse, _, err := apiClient.ToolboxAPI.ExecuteCommandDeprecated(ctx, *args.Id).
		ExecuteRequest(*apiclient.NewExecuteRequest(fmt.Sprintf("rm -rf %s", *args.FilePath))).
		Execute()
	if err != nil {
		return &mcp.CallToolResult{IsError: true}, fmt.Errorf("error deleting file: %v", err)
	}

	log.Infof("Deleted file: %s", *args.FilePath)

	return mcp.NewToolResultText(fmt.Sprintf("Deleted file: %s\nOutput: %s", *args.FilePath, execResponse.Result)), nil
}
