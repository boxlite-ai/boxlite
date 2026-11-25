// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"cloud.google.com/go/compute/metadata"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/go-playground/validator/v10"
)

// Keep credential-only wire validation separate from shared HTTP create/recover
// DTOs, whose secrets must continue to require inline values.
type createBoxJobPayload struct {
	dto.CreateBoxDTO
	SecretCredential *struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"secretCredential"`
}

func validateCreateSecrets(job *apiclient.Job, payload createBoxJobPayload) error {
	// Credential matching needs unique names; inline jobs retain backend validation.
	if payload.SecretCredential == nil {
		return nil
	}
	if payload.Id == "" || job.ResourceType != "BOX" || payload.Id != job.ResourceId || strings.TrimSpace(payload.SecretCredential.Token) == "" {
		return fmt.Errorf("invalid secret credential payload")
	}
	var wire struct {
		Secrets []struct {
			Value json.RawMessage `json:"value"`
		} `json:"secrets"`
	}
	if json.Unmarshal([]byte(*job.Payload), &wire) != nil {
		return fmt.Errorf("invalid secret credential payload")
	}
	for _, secret := range wire.Secrets {
		if secret.Value != nil {
			return fmt.Errorf("inline values forbidden with secret credential")
		}
	}
	names := make(map[string]bool, len(payload.Secrets))
	for _, secret := range payload.Secrets {
		if secret.Name == "" || names[secret.Name] {
			return fmt.Errorf("invalid create secrets")
		}
		names[secret.Name] = true
	}
	return nil
}

func (e *Executor) resolveCreateSecrets(ctx context.Context, box *dto.CreateBoxDTO, credential string) (err error) {
	started := time.Now()
	secretCount := len(box.Secrets)
	defer func() {
		result := "success"
		if err != nil {
			result = "failure"
		}
		e.log.InfoContext(ctx, "Secret retrieval", "box_id", box.Id, "secret_count", secretCount, "result", result, "latency", time.Since(started))
	}()
	// executeJob already holds the per-box lock, keyed by the validated ID.
	lookup, ok := e.backend.(interface {
		BoxExists(context.Context, string) (bool, error)
	})
	if !ok {
		return fmt.Errorf("local box lookup unavailable")
	}
	exists, err := lookup.BoxExists(ctx, box.Id)
	if err != nil {
		return fmt.Errorf("local box lookup failed")
	}
	if exists {
		box.RequireExisting = true
		box.Secrets = nil
		return nil
	}
	// Startup recovery cannot tell whether the previous process sent the POST.
	if ctx.Value(startupRecoveryKey{}) == true {
		return fmt.Errorf("secret fetch may have been attempted before runner restart. Please submit a new create request")
	}
	if e.secretFetcher == nil {
		return fmt.Errorf("secret server configuration unavailable")
	}
	box.Secrets, err = e.secretFetcher.fetch(ctx, box.Id, credential, box.Secrets)
	return err
}

type metadataGetter interface {
	GetWithContext(context.Context, string) (string, error)
}

type secretFetcher struct {
	baseURL  string
	attestor string
	metadata metadataGetter
	client   *http.Client
}

func newSecretFetcher(baseURL, attestor string) *secretFetcher {
	return &secretFetcher{
		baseURL: baseURL, attestor: attestor,
		metadata: metadata.NewWithOptions(&metadata.Options{UseDefaultClient: true}),
		client:   &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

func (f *secretFetcher) fetch(ctx context.Context, boxID, credential string, requested []dto.SecretDTO) ([]dto.SecretDTO, error) {
	base, err := url.Parse(f.baseURL)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "https" && !(base.Scheme == "http" && (base.Hostname() == "localhost" || net.ParseIP(base.Hostname()).IsLoopback()))) {
		return nil, fmt.Errorf("invalid SECRET_SERVER_URL")
	}
	if f.attestor != "" && f.attestor != "gcp_iit" {
		return nil, fmt.Errorf("unsupported runner attestor")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	identity, err := f.metadata.GetWithContext(ctx, "instance/service-accounts/default/identity?audience="+url.QueryEscape(f.baseURL)+"&format=full")
	if err != nil || strings.TrimSpace(identity) == "" {
		return nil, fmt.Errorf("attestation_failed")
	}
	body, _ := json.Marshal(struct {
		Credential string `json:"credential"`
	}{credential})
	// A non-rewindable POST body prevents transport-level credential replay.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(f.baseURL, "/")+"/internal/v1/fetch", io.NopCloser(bytes.NewReader(body)))
	if err != nil {
		return nil, fmt.Errorf("invalid SECRET_SERVER_URL")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(identity))
	req.Header.Set("X-Boxlite-Runner-Identity", strings.TrimSpace(identity))
	response, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("secret fetch outcome unknown")
	}
	defer response.Body.Close()
	// Match the Secret Server limit on the entire serialized response.
	const maxResponse = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(raw) > maxResponse {
		return nil, fmt.Errorf("invalid secret fetch response")
	}
	if response.StatusCode != http.StatusOK {
		var problem struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(raw, &problem)
		switch problem.Code {
		case "attestation_failed", "credential_invalid", "secret_unavailable", "api_unavailable", "decrypt_failed", "secret_store_unavailable":
			return nil, fmt.Errorf("secret fetch: %s", problem.Code)
		default:
			return nil, fmt.Errorf("secret fetch failed (HTTP %d)", response.StatusCode)
		}
	}
	var result struct {
		BoxID   string          `json:"box_id"`
		Secrets []dto.SecretDTO `json:"secrets"`
	}
	if json.Unmarshal(raw, &result) != nil || result.BoxID != boxID || len(result.Secrets) != len(requested) {
		return nil, fmt.Errorf("invalid secret fetch response")
	}
	byName := make(map[string]dto.SecretDTO, len(result.Secrets))
	validate := validator.New()
	for _, secret := range result.Secrets {
		if _, duplicate := byName[secret.Name]; duplicate || validate.Struct(secret) != nil {
			return nil, fmt.Errorf("invalid secret fetch response")
		}
		byName[secret.Name] = secret
	}
	secrets := make([]dto.SecretDTO, 0, len(requested))
	for _, secret := range requested {
		resolved, ok := byName[secret.Name]
		if !ok {
			return nil, fmt.Errorf("secret fetch names mismatch")
		}
		secrets = append(secrets, resolved)
	}
	return secrets, nil
}
