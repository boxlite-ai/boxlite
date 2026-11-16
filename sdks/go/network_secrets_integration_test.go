//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func newTestRuntime(t *testing.T) *Runtime {
	t.Helper()

	homeDir, err := os.MkdirTemp("/tmp", "boxlite-go-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(homeDir)
	})

	rt, err := NewRuntime(WithHomeDir(homeDir))
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrUnsupported || e.Code == ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewRuntime: %v", err)
	}
	t.Cleanup(func() {
		_ = rt.Close()
	})
	return rt
}

func createStartedBox(t *testing.T, rt *Runtime, image string, opts ...BoxOption) *Box {
	t.Helper()

	ctx := context.Background()
	box, err := rt.Create(ctx, image, opts...)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() {
		_ = box.Stop(ctx)
		_ = rt.ForceRemove(ctx, box.ID())
		_ = box.Close()
	})
	if err := box.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	return box
}

func TestIntegrationAllowNet(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(
		t,
		rt,
		"alpine:latest",
		WithNetwork(NetworkSpec{
			Outbound: OutboundNetworkSpec{
				Mode:     NetworkModeEnabled,
				AllowNet: []string{"example.com"},
			},
		}),
		WithAutoRemove(false),
	)

	result, err := box.Exec(
		context.Background(),
		"wget",
		"-q",
		"-T",
		"10",
		"-O-",
		"http://example.com",
	)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("unexpected exit code: %d stderr=%q", result.ExitCode, result.Stderr)
	}
	if !strings.Contains(strings.ToLower(result.Stdout), "example domain") {
		t.Fatalf("expected example.com response, got %q", result.Stdout)
	}
}

func TestIntegrationSecretHeaderInjection(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(
		t,
		rt,
		"python:slim",
		WithNetwork(NetworkSpec{
			Outbound: OutboundNetworkSpec{
				Mode:     NetworkModeEnabled,
				AllowNet: []string{"httpbingo.org"},
			},
		}),
		WithSecret(Secret{
			Name:    "testkey",
			Value:   "super-secret-value",
			Hosts:   []string{"httpbingo.org"},
			Headers: map[string]string{"Authorization": "Bearer {value}"},
		}),
		WithAutoRemove(false),
	)

	script := strings.Join([]string{
		"import json, os, urllib.request",
		"req = urllib.request.Request(",
		"    'https://httpbingo.org/headers',",
		"    headers={'Authorization': 'Bearer dummy', 'X-Probe': os.environ['BOXLITE_SECRET_TESTKEY']},",
		")",
		"headers = json.load(urllib.request.urlopen(req, timeout=20))['headers']",
		"print('probe=' + headers['X-Probe'][0])",
		"print('authorization=' + headers['Authorization'][0])",
	}, "\n")

	result, err := box.Exec(context.Background(), "python3", "-c", script)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("unexpected exit code: %d stderr=%q", result.ExitCode, result.Stderr)
	}
	// This echo host returns the injected header, so the value is expected there.
	if !strings.Contains(result.Stdout, "authorization=Bearer super-secret-value") {
		t.Fatalf("expected injected Authorization header, got %q", result.Stdout)
	}
	if !strings.Contains(result.Stdout, "probe=<BOXLITE_SECRET:testkey>") {
		t.Fatalf("expected placeholder to stay verbatim in other headers, got %q", result.Stdout)
	}
}
