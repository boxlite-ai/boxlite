// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

type gvproxySecret struct {
	Name        string   `json:"name"`
	Value       string   `json:"value"`
	Hosts       []string `json:"hosts"`
	Placeholder string   `json:"placeholder"`
}

type gvproxyUpdateSecretsRequest struct {
	Secrets []gvproxySecret `json:"secrets"`
}

func convertSecrets(secrets []dto.SecretDTO) []gvproxySecret {
	converted := make([]gvproxySecret, 0, len(secrets))
	for _, secret := range secrets {
		converted = append(converted, gvproxySecret{
			Name:        secret.Name,
			Value:       secret.Value,
			Hosts:       append([]string(nil), secret.Hosts...),
			Placeholder: secret.Placeholder,
		})
	}
	return converted
}

func defaultBoxliteHomeDir() string {
	if home := os.Getenv("BOXLITE_HOME"); home != "" {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ".boxlite"
	}
	return filepath.Join(home, ".boxlite")
}

func (c *Client) gvproxyAdminSocketPath(internalBoxID string) string {
	homeDir := c.homeDir
	if homeDir == "" {
		homeDir = defaultBoxliteHomeDir()
	}
	return filepath.Join(homeDir, "boxes", internalBoxID, "sockets", "gvproxy-admin.sock")
}

func gvproxyHTTPClient(socketPath string) *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", socketPath)
			},
			ResponseHeaderTimeout: 10 * time.Second,
		},
	}
}

func updateGvproxySecrets(ctx context.Context, socketPath string, secrets []dto.SecretDTO) error {
	body, err := json.Marshal(gvproxyUpdateSecretsRequest{Secrets: convertSecrets(secrets)})
	if err != nil {
		return fmt.Errorf("failed to marshal secret update request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://gvproxy/services/secrets", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to build secret update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := gvproxyHTTPClient(socketPath).Do(req)
	if err != nil {
		return fmt.Errorf("failed to contact gvproxy admin socket: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("gvproxy secret update failed with status %d", resp.StatusCode)
	}
	return nil
}

// UpdateSecrets replaces the live gvproxy secret substitution rules for a box.
func (c *Client) UpdateSecrets(ctx context.Context, boxId string, secrets []dto.SecretDTO) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return updateGvproxySecrets(ctx, c.gvproxyAdminSocketPath(bx.ID()), secrets)
}
