//go:build boxlite_dev

package boxlite

import (
	"context"
	"encoding/json"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	runnerconfig "github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestRequiredHeadersRecoveryPreservesBox(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	if _, err := runnerconfig.GetConfig(); err != nil {
		t.Fatal(err)
	}
	for _, extra := range []string{"", `,"headers":null`, `,"headers":{}`} {
		t.Run(extra, func(t *testing.T) {
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
			id := old.ID()
			var secret dto.SecretDTO
			if err := json.Unmarshal([]byte(`{"name":"x","value":"token","hosts":["api.test.com"]`+extra+`}`), &secret); err != nil {
				t.Fatal(err)
			}
			client := &Client{runtime: runtime, logger: slog.Default(), boxes: map[string]*sdk.Box{}, lastVolumeCleanup: time.Now(), volumeCleanup: volumeCleanupConfig{interval: time.Hour, dryRun: true}}
			enabled := true
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			recoverErr := client.RecoverBox(ctx, id, dto.RecoverBoxDTO{OsUser: "root", OutboundEnabled: &enabled, Secrets: []dto.SecretDTO{secret}})
			info, err := runtime.GetInfo(t.Context(), id)
			if err != nil || info.ID != id {
				t.Fatalf("invalid headers destroyed existing box: %v (recover: %v)", err, recoverErr)
			}
			if !errdefs.IsInvalidArgument(recoverErr) || !strings.Contains(recoverErr.Error(), `secret "x" has no headers; recreate the box with headers`) {
				t.Fatalf("expected actionable rejection, got %v", recoverErr)
			}
		})
	}
}
