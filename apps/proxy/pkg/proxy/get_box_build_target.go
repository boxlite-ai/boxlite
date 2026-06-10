// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/common-go/pkg/utils"
	"github.com/gin-gonic/gin"
)

func (p *Proxy) getBoxBuildTarget(ctx *gin.Context) (*url.URL, map[string]string, error) {
	// Extract box ID from the path
	match := regexp.MustCompile(`^/boxes/([\w-]+)/build-logs$`).FindStringSubmatch(ctx.Request.URL.Path)
	if len(match) != 2 {
		ctx.Error(common_errors.NewBadRequestError(errors.New("box ID is required")))
		return nil, nil, errors.New("box ID is required")
	}

	boxId := match[1]

	box, err := p.getBox(ctx, boxId)
	if err != nil {
		ctx.Error(err)
		return nil, nil, fmt.Errorf("failed to get box: %w", err)
	}

	if box.BuildInfo == nil {
		ctx.Error(common_errors.NewBadRequestError(errors.New("box has no build info")))
		return nil, nil, errors.New("box has no build info")
	}

	runnerInfo, err := p.getRunnerInfo(ctx, *box.RunnerId)
	if err != nil {
		ctx.Error(err)
		return nil, nil, fmt.Errorf("failed to get runner info: %w", err)
	}

	queryParams := ctx.Request.URL.Query()
	queryParams.Add("snapshotRef", box.BuildInfo.SnapshotRef)

	// Build the target URL
	targetURL := fmt.Sprintf("%s/snapshots/logs", runnerInfo.ApiUrl)

	// Create the complete target URL with path
	target, err := url.Parse(targetURL)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to parse target URL: %w", err)))
		return nil, nil, fmt.Errorf("failed to parse target URL: %w", err)
	}
	target.RawQuery = queryParams.Encode()

	return target, map[string]string{
		"X-BoxLite-Authorization": fmt.Sprintf("Bearer %s", runnerInfo.ApiKey),
		"X-Forwarded-Host":        ctx.Request.Host,
	}, nil
}

func (p *Proxy) getBox(ctx *gin.Context, boxId string) (*apiclient.Box, error) {
	var box *apiclient.Box
	bearerToken := p.getBearerToken(ctx)
	apiClient := p.getUserApiClient(ctx, bearerToken)

	err := utils.RetryWithExponentialBackoff(ctx, "getBox", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		s, _, e := apiClient.BoxAPI.GetBox(ctx, boxId).Execute()
		box = s
		openapiErr := common_errors.ConvertOpenAPIError(e)

		if openapiErr != nil && !common_errors.IsRetryableOpenAPIError(openapiErr) {
			return &utils.NonRetryableError{Err: openapiErr}
		}

		return openapiErr
	})
	return box, err
}
