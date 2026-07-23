// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/common-go/pkg/utils"
	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

const (
	activityUpdateTimeout    = 10 * time.Second
	directPreviewBoxIDLength = 12
	directPreviewBoxIDPrefix = "d-"
)

func (p *Proxy) GetProxyTarget(ctx *gin.Context) (*common_proxy.RequestTarget, error) {
	var targetPort, targetPath, boxIdOrSignedToken string

	// Extract port and box ID from the host header.
	// Expected format: 1234-<boxId | token>.proxy.domain
	var err error
	targetPort, boxIdOrSignedToken, _, err = p.parseHost(ctx.Request.Host)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(err))
		return nil, err
	}
	targetPath = requestEscapedPath(ctx.Request.URL, ctx.Param("path"))

	if targetPort == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("target port is required")))
		return nil, errors.New("target port is required")
	}

	if boxIdOrSignedToken == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("box ID or signed token is required")))
		return nil, errors.New("box ID or signed token is required")
	}

	boxId := boxIdOrSignedToken
	if decodedBoxId, ok, decodeErr := decodeDirectPreviewBoxID(boxIdOrSignedToken); decodeErr != nil {
		ctx.Error(common_errors.NewBadRequestError(decodeErr))
		return nil, decodeErr
	} else if ok {
		boxId = decodedBoxId
		boxIdOrSignedToken = decodedBoxId
	}

	isPublic, err := p.getBoxPublic(ctx, boxIdOrSignedToken)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to get box public status: %w", err)))
		return nil, fmt.Errorf("failed to get box public status: %w", err)
	}

	if !*isPublic || targetPort == TERMINAL_PORT {
		portFloat, err := strconv.ParseFloat(targetPort, 64)
		if err != nil {
			ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to parse target port: %w", err)))
			return nil, fmt.Errorf("failed to parse target port: %w", err)
		}
		var didRedirect bool
		boxId, didRedirect, err = p.Authenticate(ctx, boxIdOrSignedToken, float32(portFloat))
		if err != nil {
			if !didRedirect {
				ctx.Error(err)
			}
			return nil, err
		}
	}

	controllerValue, exists := ctx.Get(ACTIVITY_POLL_STOP_KEY)
	controller, ok := controllerValue.(*activityPollController)
	if !exists || !ok {
		controller = newActivityPollController()
		ctx.Set(ACTIVITY_POLL_STOP_KEY, controller)
	}
	activityCtx := context.WithoutCancel(ctx.Request.Context())
	go p.updateLastActivity(activityCtx, boxId, true, controller.done)

	forwardedProto := "http"
	if p.config != nil && p.config.ProxyProtocol != "" {
		forwardedProto = p.config.ProxyProtocol
	}
	forwardedHost := ctx.Request.Host
	forwardedPort := forwardedPortFromHost(forwardedHost, forwardedProto)

	headers := map[string]string{
		"X-Forwarded-Host":  forwardedHost,
		"X-Forwarded-Proto": forwardedProto,
		"X-Forwarded-Port":  forwardedPort,
	}

	if targetPort != TERMINAL_PORT {
		if _, err := strconv.ParseUint(targetPort, 10, 16); err != nil {
			wrappedErr := fmt.Errorf("invalid target port: %w", err)
			ctx.Error(common_errors.NewBadRequestError(wrappedErr))
			return nil, wrappedErr
		}
		target, err := url.Parse("http://" + net.JoinHostPort(boxId, targetPort) + targetPath)
		if err != nil {
			return nil, fmt.Errorf("failed to parse guest target URL: %w", err)
		}
		return &common_proxy.RequestTarget{
			URL:       target,
			Host:      forwardedHost,
			Headers:   headers,
			Transport: p.guestPortTransport,
		}, nil
	}

	runnerInfo, err := p.getBoxRunnerInfo(ctx, boxId)
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to get runner info: %w", err)))
		return nil, fmt.Errorf("failed to get runner info: %w", err)
	}
	target, err := url.Parse(fmt.Sprintf("%s/boxes/%s/toolbox/proxy/%s%s", strings.TrimRight(runnerInfo.ApiUrl, "/"), boxId, targetPort, targetPath))
	if err != nil {
		return nil, fmt.Errorf("failed to parse terminal target URL: %w", err)
	}
	headers["X-BoxLite-Authorization"] = fmt.Sprintf("Bearer %s", runnerInfo.ApiKey)
	return &common_proxy.RequestTarget{URL: target, Host: target.Host, Headers: headers}, nil
}

func (p *Proxy) dialGuestPort(ctx context.Context, network string, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, fmt.Errorf("unsupported network %q", network)
	}
	boxID, rawPort, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("parse guest endpoint: %w", err)
	}
	port, err := strconv.ParseUint(rawPort, 10, 16)
	if err != nil || port == 0 {
		return nil, fmt.Errorf("invalid guest port %q", rawPort)
	}
	runnerInfo, err := p.getBoxRunnerInfo(ctx, boxID)
	if err != nil {
		return nil, fmt.Errorf("resolve runner for box %s: %w", boxID, err)
	}
	return dialRunnerTunnel(ctx, runnerInfo, boxID, uint16(port))
}

func requestEscapedPath(requestURL *url.URL, fallbackPath string) string {
	path := fallbackPath
	if requestURL != nil && requestURL.EscapedPath() != "" {
		path = requestURL.EscapedPath()
	}
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}

func forwardedPortFromHost(host string, proto string) string {
	if _, port, err := net.SplitHostPort(host); err == nil {
		return port
	}
	if strings.EqualFold(proto, "https") {
		return "443"
	}
	if strings.EqualFold(proto, "http") {
		return "80"
	}
	return ""
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

	if cacheErr := p.boxPublicCache.Set(ctx, boxId, isPublic, 3*time.Second); cacheErr != nil {
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

func decodeDirectPreviewBoxID(value string) (string, bool, error) {
	encoded, ok := strings.CutPrefix(value, directPreviewBoxIDPrefix)
	if !ok {
		return value, false, nil
	}

	decoded, err := hex.DecodeString(encoded)
	if err != nil {
		return value, false, nil
	}
	if len(decoded) == 0 {
		return "", true, errors.New("invalid direct preview box ID: empty decoded box ID")
	}

	boxId := string(decoded)
	if !isValidDirectPreviewBoxID(boxId) {
		return "", true, errors.New("invalid direct preview box ID")
	}

	return boxId, true, nil
}

func isValidDirectPreviewBoxID(value string) bool {
	if len(value) != directPreviewBoxIDLength {
		return false
	}
	for _, ch := range value {
		if (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') {
			continue
		}
		return false
	}
	return true
}

func (p *Proxy) updateLastActivity(ctx context.Context, boxId string, shouldPoll bool, done <-chan struct{}) {
	const pollInterval = 50 * time.Second
	if shouldPoll {
		go func() {
			ticker := time.NewTicker(pollInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					p.updateLastActivity(ctx, boxId, false, done)
				case <-done:
					return
				}
			}
		}()
	}

	updateCtx, cancel := context.WithTimeout(ctx, activityUpdateTimeout)
	defer cancel()

	cached, err := p.boxLastActivityUpdateCache.Has(updateCtx, boxId)
	if err != nil {
		log.Errorf("failed to check last activity cache for box %s: %v", boxId, err)
		return
	}

	if !cached {
		if _, err := p.apiclient.BoxAPI.UpdateLastActivity(updateCtx, boxId).Execute(); err != nil {
			if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				log.Errorf("failed to update last activity for box %s: %v", boxId, err)
			}
			return
		}
		if err := p.boxLastActivityUpdateCache.Set(updateCtx, boxId, true, pollInterval-5*time.Second); err != nil {
			log.Errorf("failed to cache last activity update for box %s: %v", boxId, err)
		}
	}
}
