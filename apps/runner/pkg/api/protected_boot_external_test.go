//go:build boxlite_dev

package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
)

func TestProtectedRunnerExternalControl(t *testing.T) {
	portValue := os.Getenv("BOXLITE_TEST_PROTECTED_RUNNER_PORT")
	if portValue == "" {
		t.Skip("requires the primary-store authorization fixture")
	}
	port, err := strconv.Atoi(portValue)
	if err != nil || port < 1024 || port > 65535 {
		t.Fatal("invalid fixture port")
	}
	settings, err := config.GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("BOXLITE_TEST_PROTECTED_RUNTIME_HOME")
	if home == "" {
		home = t.TempDir()
	}
	runtime, err := blclient.NewClient(t.Context(), blclient.ClientConfig{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: runtime}); err != nil {
		t.Fatal(err)
	}
	cfg := NewProtectedBootConfig(settings.BoxliteApiUrl, settings.ApiToken)
	certificate, err := os.ReadFile(settings.TLSCertFile)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificate) {
		t.Fatal("invalid fixture certificate")
	}
	cfg.client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	server := NewApiServer(ApiServerConfig{
		Logger: slog.Default(), ApiPort: port, ApiToken: settings.ApiToken, ApiVersion: 0,
		EnableTLS: true, TLSCertFile: settings.TLSCertFile, TLSKeyFile: settings.TLSKeyFile,
		ProtectedBoot: cfg,
	})

	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.Start(ctx) }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	stopFile := os.Getenv("BOXLITE_TEST_PROTECTED_RUNNER_STOP_FILE")
	for {
		select {
		case err := <-done:
			t.Fatalf("fixture Runner listener stopped: %v", err)
		case <-ctx.Done():
			server.Stop()
			t.Fatal("fixture Runner completion signal was missing")
		case <-ticker.C:
			if _, err := os.Stat(stopFile); err == nil {
				server.Stop()
				if err := <-done; !errors.Is(err, http.ErrServerClosed) {
					t.Fatal(err)
				}
				return
			}
		}
	}
}
