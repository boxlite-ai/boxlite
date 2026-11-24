package apiclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	cloud "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

const protectedCheckpointPath = "/jobs/protected-checkpoints/"

type ProtectedCheckpointJob struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	ResourceID       string          `json:"resourceId"`
	Cleanup          bool            `json:"cleanup"`
	CleanupPublished bool            `json:"cleanupPublished"`
	Payload          json.RawMessage `json:"payload"`
}

func ClaimProtectedCheckpoint(ctx context.Context, client *cloud.APIClient, lease string) (*ProtectedCheckpointJob, error) {
	response, err := completeJobRequest(ctx, client, lease, protectedCheckpointPath+"claim", nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusForbidden {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("protected checkpoint claim returned HTTP %d", response.StatusCode)
	}
	const maxPayload = 1 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPayload+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxPayload {
		return nil, fmt.Errorf("protected checkpoint claim exceeds payload limit")
	}
	var result struct {
		Job *ProtectedCheckpointJob `json:"job"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("invalid protected checkpoint claim: %w", err)
	}
	return result.Job, nil
}

func AuthorizeProtectedCheckpoint(ctx context.Context, client *cloud.APIClient, lease, id string, cleanup bool) error {
	action := "start"
	if cleanup {
		action = "cleanup"
	}
	return sendProtectedCheckpoint(ctx, client, lease, id, action, nil)
}

func ReportProtectedCheckpoint(ctx context.Context, client *cloud.APIClient, lease, id string, receipt any) error {
	body, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return sendProtectedCheckpoint(ctx, client, lease, id, "receipt", body)
}

func sendProtectedCheckpoint(ctx context.Context, client *cloud.APIClient, lease, id, action string, body []byte) error {
	response, err := completeJobRequest(ctx, client, lease, protectedCheckpointPath+url.PathEscape(id)+"/"+action, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("protected checkpoint %s returned HTTP %d", action, response.StatusCode)
	}
	return nil
}
