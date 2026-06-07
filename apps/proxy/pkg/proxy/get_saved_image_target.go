// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/common-go/pkg/utils"
	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

func (p *Proxy) getSavedImageTarget(ctx *gin.Context) (*url.URL, map[string]string, error) {
	// Extract saved image ID from the path.
	match := regexp.MustCompile(`^/saved-images/([\w-]+)/build-logs$`).FindStringSubmatch(ctx.Request.URL.Path)
	if len(match) != 2 {
		ctx.Error(common_errors.NewBadRequestError(errors.New("saved image ID is required")))
		return nil, nil, errors.New("saved image ID is required")
	}

	savedImageId := match[1]

	savedImage, err := p.getSavedImage(ctx, savedImageId)
	if err != nil {
		ctx.Error(err)
		return nil, nil, fmt.Errorf("failed to get saved image: %w", err)
	}

	if savedImage.ArtifactRef == nil {
		ctx.Error(common_errors.NewBadRequestError(errors.New("saved image has no artifact reference")))
		return nil, nil, errors.New("saved image has no artifact reference")
	}

	if savedImage.InitialRunnerId == nil {
		ctx.Error(common_errors.NewBadRequestError(errors.New("saved image has no initial runner")))
		return nil, nil, errors.New("saved image has no initial runner")
	}

	runnerInfo, err := p.getRunnerInfo(ctx, *savedImage.InitialRunnerId)
	if err != nil {
		ctx.Error(err)
		return nil, nil, fmt.Errorf("failed to get runner info: %w", err)
	}

	queryParams := ctx.Request.URL.Query()
	queryParams.Add("artifactRef", *savedImage.ArtifactRef)

	// Build the target URL
	targetURL := fmt.Sprintf("%s/artifacts/logs", runnerInfo.ApiUrl)

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

func (p *Proxy) getSavedImage(ctx *gin.Context, savedImageId string) (*apiclient.SavedImageDto, error) {
	var savedImage *apiclient.SavedImageDto
	bearerToken := p.getBearerToken(ctx)
	apiClient := p.getUserApiClient(ctx, bearerToken)

	err := utils.RetryWithExponentialBackoff(ctx, "getSavedImage", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		t, _, e := apiClient.SavedImagesAPI.GetSavedImage(ctx, savedImageId).Execute()
		savedImage = t
		openapiErr := common_errors.ConvertOpenAPIError(e)

		if openapiErr != nil && !common_errors.IsRetryableOpenAPIError(openapiErr) {
			return &utils.NonRetryableError{Err: openapiErr}
		}

		return openapiErr
	})
	return savedImage, err
}

func (p *Proxy) getRunnerInfo(ctx context.Context, runnerId string) (*RunnerInfo, error) {
	runnerInfo, err := p.runnerCache.Get(ctx, runnerId)
	if err == nil {
		return runnerInfo, nil
	}

	var runner *apiclient.RunnerFull
	err = utils.RetryWithExponentialBackoff(ctx, "getRunnerInfo", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		r, _, e := p.apiclient.RunnersAPI.GetRunnerFullById(context.Background(), runnerId).Execute()
		runner = r
		openapiErr := common_errors.ConvertOpenAPIError(e)

		if openapiErr != nil && !common_errors.IsRetryableOpenAPIError(openapiErr) {
			return &utils.NonRetryableError{Err: openapiErr}
		}

		return openapiErr
	})
	if err != nil {
		return nil, err
	}

	if runner.ApiUrl == nil {
		return nil, errors.New("runner API URL not found")
	}

	info := RunnerInfo{
		ApiUrl: *runner.ApiUrl,
		ApiKey: runner.ApiKey,
	}

	err = p.runnerCache.Set(ctx, runnerId, info, 2*time.Minute)
	if err != nil {
		log.Errorf("Failed to set runner info in cache: %v", err)
	}

	return &info, nil
}
