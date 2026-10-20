package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// lockedBuffer collects log output written from proxy goroutines while the
// test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogOutput sends formatted logrus output, fields included, to a
// buffer at the most verbose level for the rest of the test.
func captureLogOutput(t *testing.T) *lockedBuffer {
	t.Helper()
	logger := logrus.StandardLogger()
	out, level := logger.Out, logger.GetLevel()
	logs := &lockedBuffer{}
	logger.SetOutput(logs)
	logger.SetLevel(logrus.TraceLevel)
	t.Cleanup(func() {
		logger.SetOutput(out)
		logger.SetLevel(level)
	})
	return logs
}

func newCanary(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return "canary-not-a-real-key-" + hex.EncodeToString(raw)
}

func sendPlaceholder(t *testing.T, client *http.Client) (*http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.example.com/canary", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:k>")
	return client.Do(req)
}

// TestMitmProxy_CanaryStaysOutOfLogsAndResponses sends a placeholder through
// the proxy at Trace log level, to an upstream that reads the value without
// echoing it and to one that is down. The value must reach the first upstream
// and nothing else: not the guest's response, not a log line (POL-1024).
func TestMitmProxy_CanaryStaysOutOfLogsAndResponses(t *testing.T) {
	logs := captureLogOutput(t)
	canary := newCanary(t)

	// Positive control: an absence check passes trivially if the collector
	// never sees log output at all.
	logrus.WithField("probe", canary).Trace("positive control")
	if !strings.Contains(logs.String(), canary) {
		t.Fatal("log capture missed a planted canary; the checks below would prove nothing")
	}
	planted := logs.String()

	ca := newTestCA(t)
	secrets := []SecretConfig{{
		Name:        "k",
		Hosts:       []string{"api.example.com"},
		Placeholder: "<BOXLITE_SECRET:k>",
		Value:       canary,
	}}

	received := make(chan string, 2)
	addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Get("Authorization")
		fmt.Fprint(w, "ok")
	})
	defer cleanup()

	for name, client := range map[string]*http.Client{
		"http1": dialThroughMITM(t, ca, "api.example.com", addr, secrets),
		"http2": dialThroughMITMH2(t, ca, "api.example.com", addr, secrets),
	} {
		resp, err := sendPlaceholder(t, client)
		if err != nil {
			t.Fatalf("%s: request failed: %v", name, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		// The substitution must have happened, or the absence below is empty.
		if got := <-received; got != "Bearer "+canary {
			t.Fatalf("%s: upstream got %q, want the substituted value", name, got)
		}
		if strings.Contains(string(body), canary) {
			t.Errorf("%s: response to the guest holds the canary: %s", name, body)
		}
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := ln.Addr().String()
	ln.Close()
	if resp, err := sendPlaceholder(t, dialThroughMITM(t, ca, "api.example.com", deadAddr, secrets)); err == nil {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(body), canary) {
			t.Errorf("error response to the guest holds the canary: %s", body)
		}
	}

	// The error path logs; wait for it so the scan covers that line too.
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), "MITM: upstream error") && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	proxyLogs := strings.TrimPrefix(logs.String(), planted)
	if !strings.Contains(proxyLogs, "MITM: upstream error") {
		t.Fatalf("the upstream-error path logged nothing; logs: %s", proxyLogs)
	}
	if strings.Contains(proxyLogs, canary) {
		t.Errorf("proxy logs hold the canary:\n%s", proxyLogs)
	}
}
