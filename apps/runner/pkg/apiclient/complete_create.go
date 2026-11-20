// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	cloud "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

const completeJobPath = "/jobs/complete-outbound/"

func ClaimCompleteCreate(ctx context.Context, client *cloud.APIClient, lease string) (*dto.CompleteCreateRequest, error) {
	response, err := completeJobRequest(ctx, client, lease, completeJobPath+"claim", nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		// Older APIs have only the ordinary lifecycle queue.
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("complete create claim returned HTTP %d", response.StatusCode)
	}
	const maxPayload = 1 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPayload+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxPayload {
		return nil, fmt.Errorf("complete create claim exceeds payload limit")
	}
	var result struct {
		Request *dto.CompleteCreateRequest `json:"request"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("invalid complete create claim: %w", err)
	}
	return result.Request, nil
}

func ReportCompleteCreate(ctx context.Context, client *cloud.APIClient, lease string, receipt dto.CompleteCreateResult) error {
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	path := completeJobPath + url.PathEscape(receipt.Attempt.JobID) + "/receipt"
	response, err := completeJobRequest(ctx, client, lease, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("complete create receipt returned HTTP %d", response.StatusCode)
	}
	return nil
}

func completeJobRequest(ctx context.Context, client *cloud.APIClient, lease, path string, body []byte) (*http.Response, error) {
	config := client.GetConfig()
	endpoint, err := config.ServerURLWithContext(ctx, "")
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(endpoint, "/")+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range config.DefaultHeader {
		request.Header.Set(key, value)
	}
	request.Header.Set("X-BoxLite-Complete-Lease", lease)
	request.Header.Set("Content-Type", "application/json")
	transport := *config.HTTPClient
	transport.Timeout = 10 * time.Second
	// The worker lease must only reach its configured control plane.
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return transport.Do(request)
}
