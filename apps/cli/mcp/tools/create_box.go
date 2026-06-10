// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package tools

import (
	"context"
	"fmt"
	"strings"
	"time"

	apiclient_cli "github.com/boxlite-ai/boxlite/cli/apiclient"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/mark3labs/mcp-go/mcp"

	log "github.com/sirupsen/logrus"
)

type CreateBoxArgs struct {
	Id                 *string                    `json:"id,omitempty"`
	Name               *string                    `json:"name,omitempty"`
	Target             *string                    `json:"target,omitempty"`
	User               *string                    `json:"user,omitempty"`
	Env                *map[string]string         `json:"env,omitempty"`
	Labels             *map[string]string         `json:"labels,omitempty"`
	Public             *bool                      `json:"public,omitempty"`
	Cpu                *int32                     `json:"cpu,omitempty"`
	Gpu                *int32                     `json:"gpu,omitempty"`
	Memory             *int32                     `json:"memory,omitempty"`
	Disk               *int32                     `json:"disk,omitempty"`
	AutoStopInterval   *int32                     `json:"autoStopInterval,omitempty"`
	AutoDeleteInterval *int32                     `json:"autoDeleteInterval,omitempty"`
	Volumes            *[]apiclient.BoxVolume     `json:"volumes,omitempty"`
	BuildInfo          *apiclient.CreateBuildInfo `json:"buildInfo,omitempty"`
	NetworkBlockAll    *bool                      `json:"networkBlockAll,omitempty"`
	NetworkAllowList   *string                    `json:"networkAllowList,omitempty"`
}

func GetCreateBoxTool() mcp.Tool {
	return mcp.NewTool("create_box",
		mcp.WithDescription("Create a new box with BoxLite"),
		mcp.WithString("id", mcp.Description("If a box ID is provided it is first checked if it exists and is running, if so, the existing box will be used. However, a model is not able to provide custom box ID but only the ones BoxLite commands return and should always leave ID field empty if the intention is to create a new box.")),
		mcp.WithString("name", mcp.Description("Name of the box. If not provided, the box ID will be used as the name.")),
		mcp.WithString("target", mcp.DefaultString("us"), mcp.Description("Target region of the box.")),
		mcp.WithString("user", mcp.Description("User associated with the box.")),
		mcp.WithObject("env", mcp.Description("Environment variables for the box. Format: {\"key\": \"value\", \"key2\": \"value2\"}"), mcp.AdditionalProperties(map[string]any{"type": "string"})),
		mcp.WithObject("labels", mcp.Description("Labels for the box. Format: {\"key\": \"value\", \"key2\": \"value2\"}"), mcp.AdditionalProperties(map[string]any{"type": "string"})),
		mcp.WithBoolean("public", mcp.Description("Whether the box http preview is publicly accessible.")),
		mcp.WithNumber("cpu", mcp.Description("CPU cores allocated to the box."), mcp.Max(4)),
		mcp.WithNumber("gpu", mcp.Description("GPU units allocated to the box."), mcp.Max(1)),
		mcp.WithNumber("memory", mcp.Description("Memory allocated to the box in GB."), mcp.Max(8)),
		mcp.WithNumber("disk", mcp.Description("Disk space allocated to the box in GB."), mcp.Max(10)),
		mcp.WithNumber("autoStopInterval", mcp.DefaultNumber(15), mcp.Min(0), mcp.Description("Auto-stop interval in minutes (0 means disabled) for the box.")),
		mcp.WithNumber("autoDeleteInterval", mcp.DefaultNumber(-1), mcp.Description("Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping) for the box.")),
		mcp.WithArray("volumes", mcp.Description("Volumes to attach to the box."), mcp.Items(map[string]any{"type": "object", "properties": map[string]any{"volumeId": map[string]any{"type": "string"}, "mountPath": map[string]any{"type": "string"}}})),
		mcp.WithObject("buildInfo", mcp.Description("Build information for the box."), mcp.Properties(map[string]any{"dockerfileContent": map[string]any{"type": "string"}, "contextHashes": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}})),
		mcp.WithBoolean("networkBlockAll", mcp.Description("Whether to block all network access to the box.")),
		mcp.WithString("networkAllowList", mcp.Description("Comma-separated list of domains to allow network access to the box.")),
	)
}

func CreateBox(ctx context.Context, request mcp.CallToolRequest, args CreateBoxArgs) (*mcp.CallToolResult, error) {
	apiClient, err := apiclient_cli.GetApiClient(nil, boxliteMCPHeaders)
	if err != nil {
		return &mcp.CallToolResult{IsError: true}, err
	}

	boxId := ""
	if args.Id != nil && *args.Id != "" {
		boxId = *args.Id
	}

	if boxId != "" {
		box, _, err := apiClient.BoxAPI.GetBox(ctx, boxId).Execute()
		if err == nil && box.State != nil && *box.State == apiclient.BOXSTATE_STARTED {
			return mcp.NewToolResultText(fmt.Sprintf("Reusing existing box %s", boxId)), nil
		}

		return &mcp.CallToolResult{IsError: true}, fmt.Errorf("box %s not found or not running", boxId)
	}

	createBoxReq, err := createBoxRequest(args)
	if err != nil {
		return &mcp.CallToolResult{IsError: true}, err
	}

	// Create new box with retries
	maxRetries := 3
	retryDelay := time.Second * 2

	for retry := range maxRetries {
		box, _, err := apiClient.BoxAPI.CreateBox(ctx).CreateBox(*createBoxReq).Execute()
		if err != nil {
			if strings.Contains(err.Error(), "Total CPU quota exceeded") {
				return &mcp.CallToolResult{IsError: true}, fmt.Errorf("CPU quota exceeded. Please delete unused boxes or upgrade your plan")
			}

			if retry == maxRetries-1 {
				return &mcp.CallToolResult{IsError: true}, fmt.Errorf("failed to create box after %d retries: %v", maxRetries, err)
			}

			log.Infof("Box creation failed, retrying: %v", err)

			time.Sleep(retryDelay)
			retryDelay = retryDelay * 3 / 2 // Exponential backoff
			continue
		}

		log.Infof("Created new box: %s", box.Id)

		return mcp.NewToolResultText(fmt.Sprintf("Created new box %s", box.Id)), nil
	}

	return &mcp.CallToolResult{IsError: true}, fmt.Errorf("failed to create box after %d retries", maxRetries)
}

func createBoxRequest(args CreateBoxArgs) (*apiclient.CreateBox, error) {
	createBox := apiclient.NewCreateBox()

	if args.Name != nil && *args.Name != "" {
		createBox.SetName(*args.Name)
	}

	if args.Target != nil && *args.Target != "" {
		createBox.SetTarget(*args.Target)
	}

	if args.AutoStopInterval != nil {
		createBox.SetAutoStopInterval(*args.AutoStopInterval)
	}

	if args.AutoDeleteInterval != nil {
		createBox.SetAutoDeleteInterval(*args.AutoDeleteInterval)
	}

	if args.User != nil && *args.User != "" {
		createBox.SetUser(*args.User)
	}

	if args.Env != nil {
		createBox.SetEnv(*args.Env)
	}

	if args.Labels != nil {
		createBox.SetLabels(*args.Labels)
	}

	if args.Public != nil {
		createBox.SetPublic(*args.Public)
	}

	if args.Cpu != nil {
		createBox.SetCpu(*args.Cpu)
	}

	if args.Memory != nil {
		createBox.SetMemory(*args.Memory)
	}

	if args.Disk != nil {
		createBox.SetDisk(*args.Disk)
	}

	if args.Volumes != nil {
		createBox.SetVolumes(*args.Volumes)
	}

	if args.BuildInfo != nil {
		createBox.SetBuildInfo(*args.BuildInfo)
	}

	if args.NetworkBlockAll != nil {
		createBox.SetNetworkBlockAll(*args.NetworkBlockAll)
	}

	if args.NetworkAllowList != nil {
		createBox.SetNetworkAllowList(*args.NetworkAllowList)
	}

	return createBox, nil
}
