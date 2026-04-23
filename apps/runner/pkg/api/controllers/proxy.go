// Copyright 2025 Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"

	common_errors "github.com/daytonaio/common-go/pkg/errors"
	proxy "github.com/daytonaio/common-go/pkg/proxy"
	"github.com/daytonaio/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// ProxyRequest handles proxying requests to a sandbox's toolbox daemon
func ProxyRequest(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		if ctx.Request.Header.Get("Upgrade") != "websocket" && regexp.MustCompile(`^/process/session/.+/command/.+/logs$`).MatchString(ctx.Param("path")) {
			if ctx.Query("follow") == "true" {
				ProxyCommandLogsStream(ctx, logger)
				return
			}
		}

		proxy.NewProxyRequestHandler(getProxyTarget, nil)(ctx)
	}
}

func getProxyTarget(ctx *gin.Context) (*url.URL, map[string]string, error) {
	_, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return nil, nil, err
	}

	sandboxId := ctx.Param("sandboxId")
	if sandboxId == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("sandbox ID is required")))
		return nil, nil, errors.New("sandbox ID is required")
	}

	// BoxLite VMs expose the daemon port via port forwarding.
	// The sandbox ID is used as the hostname with port 2280.
	targetURL := fmt.Sprintf("http://%s:2280", sandboxId)

	path := ctx.Param("path")
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	target, err := url.Parse(fmt.Sprintf("%s%s", targetURL, path))
	if err != nil {
		ctx.Error(common_errors.NewBadRequestError(fmt.Errorf("failed to parse target URL: %w", err)))
		return nil, nil, fmt.Errorf("failed to parse target URL: %w", err)
	}

	return target, nil, nil
}
