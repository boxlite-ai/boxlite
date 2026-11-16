//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"context"
	"encoding/json"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	runnerconfig "github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func secretHeadersFromWire(t *testing.T, headers map[string]string, value string) dto.SecretDTO {
	t.Helper()
	wire := map[string]any{"name": "key", "value": value, "hosts": []string{"api.example.com"}}
	if headers != nil {
		wire["headers"] = headers
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var secret dto.SecretDTO
	if err := json.Unmarshal(encoded, &secret); err != nil {
		t.Fatal(err)
	}
	return secret
}

func TestSecretHeadersForwardTemplates(t *testing.T) {
	templates := map[string]string{"Authorization": "Bot {value}", "X-Key": "{value}"}
	got := secretSpecs([]dto.SecretDTO{secretHeadersFromWire(t, templates, "token")})
	encoded, err := json.Marshal(got[0])
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	var actual map[string]string
	if data := wire["Headers"]; data != nil {
		if err := json.Unmarshal(data, &actual); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(actual, templates) {
		t.Fatalf("forwarded templates = %v, want %v", actual, templates)
	}
}

func TestSecretHeadersAllowDistinctHeadersOnOneHost(t *testing.T) {
	secrets := []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{"Authorization": "Bearer {value}"}, "one"), secretHeadersFromWire(t, map[string]string{"X-Key": "{value}"}, "two")}
	if err := validateRecreatableSecrets(secrets); err != nil {
		t.Fatal(err)
	}
}

func TestSecretHeadersRecoveryKeepsOldBox(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	if _, err := runnerconfig.GetConfig(); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]dto.SecretDTO{}
	for _, name := range []string{"Host", "Connection", "Proxy-Connection", "proxy-authenticate", "Proxy-Authorization", "Keep-Alive", "TE", "Trailer", "Upgrade", "Content-Length", "Transfer-Encoding", "Bad Header", ""} {
		cases["name "+name] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{name: "{value}"}, "private-token")}
	}
	for _, template := range []string{"", "raw", "{value}{value}", "{other}{value}", "{value}\r\n", "{value}\u007f"} {
		cases["template "+template] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{"X-Key": template}, "private-token")}
	}
	cases["missing map"] = []dto.SecretDTO{secretHeadersFromWire(t, nil, "private-token")}
	cases["empty map"] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{}, "private-token")}
	cases["duplicate names"] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{"X-Key": "{value}", "x-key": "{value}"}, "private-token")}
	cases["duplicate host header"] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{"X-Key": "{value}"}, "private-token"), secretHeadersFromWire(t, map[string]string{"x-key": "{value}"}, "other")}
	for _, control := range []string{"\x00", "\x01", "\r", "\n", "\x7f"} {
		cases["value "+control] = []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{"Authorization": "Bearer {value}"}, "private-token"+control)}
	}
	for name, secrets := range cases {
		t.Run(name, func(t *testing.T) {
			// No VM boot or external registry: even the broken recovery path
			// can only attempt to pull from a closed local endpoint.
			runtime, err := sdk.NewRuntime(sdk.WithHomeDir(t.TempDir()), sdk.WithImageRegistry(sdk.ImageRegistry{Host: "127.0.0.1:1", Search: true, Transport: sdk.RegistryTransportHTTP}))
			if err != nil {
				skipOrFailRuntimeStart(t, err)
			}
			defer runtime.Close()
			old, err := runtime.Create(t.Context(), "", sdk.WithRootfsPath(t.TempDir()), sdk.WithAutoRemove(false))
			if err != nil {
				t.Fatal(err)
			}
			defer old.Close()
			oldID := old.ID()
			client := &Client{runtime: runtime, logger: slog.Default(), boxes: map[string]*sdk.Box{}, lastVolumeCleanup: time.Now(), volumeCleanup: volumeCleanupConfig{interval: time.Hour, dryRun: true}}
			enabled := true
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			recoverErr := client.RecoverBox(ctx, oldID, dto.RecoverBoxDTO{OsUser: "root", OutboundEnabled: &enabled, Secrets: secrets})
			info, err := runtime.GetInfo(t.Context(), oldID)
			if err != nil || info.ID != oldID {
				t.Fatalf("invalid secret configuration destroyed the old box: %v (recovery: %v)", err, recoverErr)
			}
			if !errdefs.IsInvalidArgument(recoverErr) {
				t.Fatalf("expected invalid argument, got %v", recoverErr)
			}
			if strings.Contains(recoverErr.Error(), "private-token") {
				t.Fatal("error exposed secret value")
			}
		})
	}
}

func TestSecretHeadersCreateRejectsExplicitEmptyMap(t *testing.T) {
	runtime, err := sdk.NewRuntime(sdk.WithHomeDir(t.TempDir()), sdk.WithImageRegistry(sdk.ImageRegistry{Host: "127.0.0.1:1", Search: true, Transport: sdk.RegistryTransportHTTP}))
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	defer runtime.Close()
	client := &Client{runtime: runtime, logger: slog.Default(), boxes: map[string]*sdk.Box{}}
	enabled := true
	_, _, err = client.Create(t.Context(), dto.CreateBoxDTO{Id: "empty-headers", Image: "alpine:latest", OutboundEnabled: &enabled,
		Secrets: []dto.SecretDTO{secretHeadersFromWire(t, map[string]string{}, "private-token")}})
	if !errdefs.IsInvalidArgument(err) {
		t.Fatalf("Create accepted an empty headers map: %v", err)
	}
}
