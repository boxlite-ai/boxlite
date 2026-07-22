// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/common-go/pkg/utils"
	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

func (p *Proxy) GetProxyTarget(ctx *gin.Context) (*url.URL, map[string]string, error) {
	var targetPort, targetPath, boxIdOrSignedToken string

	// Extract port and box ID from the host header.
	// Expected format: 1234-<boxId | token>.proxy.domain
	var err error
	targetPort, boxIdOrSignedToken, _, err = p.parseHost(ctx.Request.Host)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(err))
		return nil, nil, err
	}
	targetPath = ctx.Param("path")

	if targetPort == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("target port is required")))
		return nil, nil, errors.New("target port is required")
	}

	if boxIdOrSignedToken == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("box ID or signed token is required")))
		return nil, nil, errors.New("box ID or signed token is required")
	}

	boxId := boxIdOrSignedToken

	isPublic, err := p.getBoxPublic(ctx, boxIdOrSignedToken)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to get box public status: %w", err)))
		return nil, nil, fmt.Errorf("failed to get box public status: %w", err)
	}

	if !*isPublic || targetPort == TERMINAL_PORT {
		portFloat, err := strconv.ParseFloat(targetPort, 64)
		if err != nil {
			ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to parse target port: %w", err)))
			return nil, nil, fmt.Errorf("failed to parse target port: %w", err)
		}
		var didRedirect bool
		boxId, didRedirect, err = p.Authenticate(ctx, boxIdOrSignedToken, float32(portFloat))
		if err != nil {
			if !didRedirect {
				ctx.Error(err)
			}
			return nil, nil, err
		}
	}

	runnerInfo, err := p.getBoxRunnerInfo(ctx, boxId)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to get runner info: %w", err)))
		return nil, nil, fmt.Errorf("failed to get runner info: %w", err)
	}

	// Build the target URL
	targetURL := fmt.Sprintf("%s/boxes/%s/toolbox/proxy/%s", runnerInfo.ApiUrl, boxId, targetPort)

	// Ensure path always has a leading slash but not duplicate slashes
	if targetPath == "" {
		targetPath = "/"
	} else if !strings.HasPrefix(targetPath, "/") {
		targetPath = "/" + targetPath
	}

	// Create the complete target URL with path
	target, err := url.Parse(fmt.Sprintf("%s%s", targetURL, targetPath))
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to parse target URL: %w", err)))
		return nil, nil, fmt.Errorf("failed to parse target URL: %w", err)
	}

	return target, map[string]string{
		"X-BoxLite-Authorization": fmt.Sprintf("Bearer %s", runnerInfo.ApiKey),
		"X-Forwarded-Host":        ctx.Request.Host,
	}, nil
}

func (p *Proxy) getBoxRunnerInfo(ctx context.Context, boxId string) (*RunnerInfo, error) {
	runnerInfo, err := p.boxRunnerCache.Get(ctx, boxId)
	if err == nil {
		return runnerInfo, nil
	}

	var runner *apiclient.RunnerFull
	err = utils.RetryWithExponentialBackoff(ctx, "getBoxRunnerInfo", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		r, _, e := p.apiclient.RunnersAPI.GetRunnerByBoxId(context.Background(), boxId).Execute()
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

	if runner.ProxyUrl == nil {
		return nil, errors.New("runner proxy URL not found")
	}

	info := RunnerInfo{
		ApiUrl: *runner.ProxyUrl,
		ApiKey: runner.ApiKey,
	}

	err = p.boxRunnerCache.Set(ctx, boxId, info, 2*time.Minute)
	if err != nil {
		log.Errorf("Failed to set runner info in cache: %v", err)
	}

	return &info, nil
}

func (p *Proxy) getBoxPublic(ctx context.Context, boxId string) (*bool, error) {
	isPublicCache, err := p.boxPublicCache.Get(ctx, boxId)
	if err == nil {
		return isPublicCache, nil
	}

	var isPublic bool
	err = utils.RetryWithExponentialBackoff(ctx, "getBoxPublic", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		_, res, err := p.apiclient.PreviewAPI.IsBoxPublic(context.Background(), boxId).Execute()
		if res != nil && res.StatusCode == http.StatusOK {
			isPublic = true
			return nil
		}
		openapiErr := common_errors.ConvertOpenAPIError(err)

		if openapiErr != nil {
			if res != nil && res.StatusCode >= 400 && res.StatusCode < 500 &&
				res.StatusCode != http.StatusRequestTimeout && res.StatusCode != http.StatusTooManyRequests {
				isPublic = false
				return nil
			}
			if !common_errors.IsRetryableOpenAPIError(openapiErr) {
				return &utils.NonRetryableError{Err: openapiErr}
			}
			return openapiErr
		}
		isPublic = false
		return nil
	})
	if err != nil {
		return nil, err
	}

	if cacheErr := p.boxPublicCache.Set(ctx, boxId, isPublic, 1*time.Hour); cacheErr != nil {
		log.Errorf("Failed to set box public in cache: %v", cacheErr)
	}

	return &isPublic, nil
}

func (p *Proxy) getBoxAuthKeyValid(ctx context.Context, boxId string, authKey string) (*bool, error) {
	apiValidation := func() (bool, error) {
		_, resp, err := p.apiclient.PreviewAPI.IsValidAuthToken(context.Background(), boxId, authKey).Execute()
		if resp != nil && resp.StatusCode == http.StatusOK {
			return true, nil
		}
		openapiErr := common_errors.ConvertOpenAPIError(err)

		if openapiErr != nil {
			if resp != nil && resp.StatusCode >= 400 && resp.StatusCode < 500 &&
				resp.StatusCode != http.StatusRequestTimeout && resp.StatusCode != http.StatusTooManyRequests {
				return false, nil
			}
			if !common_errors.IsRetryableOpenAPIError(openapiErr) {
				return false, &utils.NonRetryableError{Err: openapiErr}
			}
			return false, openapiErr
		}
		return false, nil
	}

	return p.validateAndCache(ctx, boxId, authKey, apiValidation)
}

func (p *Proxy) getBoxBearerTokenValid(ctx context.Context, boxId string, bearerToken string) (*bool, error) {
	apiValidation := func() (bool, error) {
		return p.hasBoxAccess(ctx, boxId, bearerToken)
	}

	return p.validateAndCache(ctx, boxId, bearerToken, apiValidation)
}

func (p *Proxy) validateAndCache(
	ctx context.Context,
	boxId string,
	authKey string,
	apiValidation func() (bool, error),
) (*bool, error) {
	cacheKey := fmt.Sprintf("%s:%s", boxId, authKey)
	authKeyValidCache, err := p.boxAuthKeyValidCache.Get(ctx, cacheKey)
	if err == nil {
		return authKeyValidCache, nil
	}

	var isValid bool
	validationErr := utils.RetryWithExponentialBackoff(ctx, "validateAndCache", proxyMaxRetries, proxyBaseDelay, proxyMaxDelay, func() error {
		result, err := apiValidation()
		if err != nil {
			return err
		}
		isValid = result
		return nil
	})
	if validationErr != nil {
		return nil, validationErr
	}

	if err := p.boxAuthKeyValidCache.Set(ctx, cacheKey, isValid, 2*time.Minute); err != nil {
		log.Errorf("Failed to set box auth key valid in cache: %v", err)
	}

	return &isValid, nil
}

func (p *Proxy) parseHost(host string) (targetPort string, boxIdOrSignedToken string, baseHost string, err error) {
	// Extract port and box ID from the host header
	// Expected format: 1234-some-id-uuid.proxy.domain
	if host == "" {
		return "", "", "", errors.New("host is required")
	}

	// Split the host to extract the port and box ID
	parts := strings.Split(host, ".")
	if len(parts) == 0 {
		return "", "", "", errors.New("invalid host format")
	}

	if len(parts) < 2 {
		return "", "", "", errors.New("invalid host format: must have subdomain")
	}

	// Extract port from the first part (e.g., "1234-some-id-uuid")
	hostPrefix := parts[0]
	before, after, ok := strings.Cut(hostPrefix, "-")
	if !ok {
		return "", "", "", errors.New("invalid host format: port and box ID not found")
	}

	targetPort = before

	// Check that port is numeric
	if _, err := strconv.Atoi(targetPort); err != nil {
		return "", "", "", fmt.Errorf("invalid port '%s': must be numeric", targetPort)
	}

	boxIdOrSignedToken = after
	// Join remaining parts to form the base domain (e.g., "proxy.domain")
	baseHost = strings.Join(parts[1:], ".")

	return targetPort, boxIdOrSignedToken, baseHost, nil
}
