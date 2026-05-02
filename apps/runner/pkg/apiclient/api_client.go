// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package apiclient

import (
	"net/http"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

var apiClient *apiclient.APIClient

const BoxliteSourceHeader = "X-BoxLite-Source"

func GetApiClient() (*apiclient.APIClient, error) {
	c, err := config.GetConfig()
	if err != nil {
		return nil, err
	}

	var newApiClient *apiclient.APIClient

	serverUrl := c.BoxliteApiUrl

	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers = apiclient.ServerConfigurations{
		{
			URL: serverUrl,
		},
	}

	clientConfig.AddDefaultHeader("Authorization", "Bearer "+c.ApiToken)

	clientConfig.AddDefaultHeader(BoxliteSourceHeader, "runner")

	newApiClient = apiclient.NewAPIClient(clientConfig)

	newApiClient.GetConfig().HTTPClient = &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
	}

	apiClient = newApiClient
	return apiClient, nil
}
