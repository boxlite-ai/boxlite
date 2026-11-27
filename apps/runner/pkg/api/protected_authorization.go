package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	runnerbox "github.com/boxlite-ai/runner/pkg/boxlite"
)

var errProtectedAuthorization = errors.New("protected bootstrap authorization unavailable")

type ProtectedBootConfig struct {
	controlPlane *url.URL
	token        string
	client       *http.Client
}

func NewProtectedBootConfig(apiURL, token string) ProtectedBootConfig {
	endpoint, err := url.Parse(apiURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil ||
		endpoint.RawQuery != "" || endpoint.Fragment != "" || token == "" {
		return ProtectedBootConfig{}
	}
	return ProtectedBootConfig{
		controlPlane: endpoint,
		token:        token,
		client: &http.Client{
			Timeout: 3 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

type protectedGrantRequest struct {
	Operation   string           `json:"operation"`
	BoxID       string           `json:"box_id"`
	Key         protectedBootKey `json:"key"`
	Fingerprint string           `json:"fingerprint,omitempty"`
	NativeID    string           `json:"native_id,omitempty"`
}

func (c ProtectedBootConfig) call(ctx context.Context, method, path string, body io.Reader) (runnerbox.ProtectedBootAdmission, error) {
	var result runnerbox.ProtectedBootAdmission
	if c.controlPlane == nil || c.client == nil {
		return result, errProtectedAuthorization
	}
	endpoint := c.controlPlane.JoinPath("runners", "protected-bootstrap", path)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return result, errProtectedAuthorization
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return result, errProtectedAuthorization
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK ||
		json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil || result.RunnerID == "" {
		return result, errProtectedAuthorization
	}
	return result, nil
}

func (c ProtectedBootConfig) authorize(ctx context.Context, request protectedGrantRequest) (runnerbox.ProtectedBootAdmission, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return runnerbox.ProtectedBootAdmission{}, errProtectedAuthorization
	}
	grant, err := c.call(ctx, http.MethodPost, "authorize", bytes.NewReader(body))
	if err != nil || grant.RunnerID != request.Key.RunnerID {
		return runnerbox.ProtectedBootAdmission{}, errProtectedAuthorization
	}
	return grant, nil
}

func requestFingerprint(body []byte, encodedKey string) (string, error) {
	key, err := base64.RawURLEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != 32 {
		return "", errProtectedAuthorization
	}
	fingerprint := hmac.New(sha256.New, key)
	_, _ = fingerprint.Write(body)
	return hex.EncodeToString(fingerprint.Sum(nil)), nil
}
