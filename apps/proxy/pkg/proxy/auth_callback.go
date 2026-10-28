// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/common-go/pkg/utils"
)

func (p *Proxy) hasBoxAccess(ctx context.Context, boxId string, authToken string) (bool, error) {
	apiClient := p.getUserApiClient(ctx, authToken)

	_, res, err := apiClient.PreviewAPI.HasBoxAccess(ctx, boxId).Execute()
	if res != nil && res.StatusCode == http.StatusOK {
		return true, nil
	}
	openapiErr := common_errors.ConvertOpenAPIError(err)

	if openapiErr != nil {
		if res != nil && res.StatusCode >= 400 && res.StatusCode < 500 &&
			res.StatusCode != http.StatusRequestTimeout && res.StatusCode != http.StatusTooManyRequests {
			return false, nil
		}
		if !common_errors.IsRetryableOpenAPIError(openapiErr) {
			return false, &utils.NonRetryableError{Err: openapiErr}
		}

		return false, openapiErr
	}

	return false, nil
}

type clientIPContextKey struct{}

func (p *Proxy) getUserApiClient(ctx context.Context, authToken string) *apiclient.APIClient {
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers = apiclient.ServerConfigurations{
		{
			URL: p.apiclient.GetConfig().Servers[0].URL,
		},
	}
	clientConfig.AddDefaultHeader("Authorization", "Bearer "+authToken)
	if ginCtx, ok := ctx.(*gin.Context); ok {
		clientConfig.AddDefaultHeader("X-Forwarded-For", ginCtx.ClientIP())
	} else if ip, ok := ctx.Value(clientIPContextKey{}).(string); ok {
		clientConfig.AddDefaultHeader("X-Forwarded-For", ip)
	}

	apiClient := apiclient.NewAPIClient(clientConfig)

	return apiClient
}

func (p *Proxy) getOidcEndpoint(ctx context.Context) (context.Context, *oauth2.Endpoint, error) {
	providerCtx := ctx
	// If the public domain is set, override the issuer URL to the private domain
	if p.config.Oidc.PublicDomain != nil && *p.config.Oidc.PublicDomain != "" {
		providerCtx = oidc.InsecureIssuerURLContext(ctx, p.config.Oidc.Domain)
	}
	provider, err := oidc.NewProvider(providerCtx, p.config.Oidc.Domain)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to initialize OIDC provider: %w", err)
	}

	endpoint := provider.Endpoint()

	// Override endpoints to use internal domain
	if p.config.Oidc.PublicDomain != nil && *p.config.Oidc.PublicDomain != "" {
		endpoint.TokenURL = strings.Replace(endpoint.TokenURL, *p.config.Oidc.PublicDomain, p.config.Oidc.Domain, 1)
		// endpoint.AuthURL = strings.Replace(endpoint.AuthURL, *p.config.Oidc.PublicDomain, p.config.Oidc.Domain, 1)
		endpoint.DeviceAuthURL = strings.Replace(endpoint.DeviceAuthURL, *p.config.Oidc.PublicDomain, p.config.Oidc.Domain, 1)
	}

	return providerCtx, &endpoint, nil
}

func GenerateRandomState() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	if err != nil {
		return "", err
	}

	return base64.URLEncoding.EncodeToString(b), nil
}
