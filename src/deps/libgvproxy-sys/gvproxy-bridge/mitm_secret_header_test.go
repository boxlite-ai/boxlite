package main

import (
	"io"
	"net/http"
	"net/http/httputil"
	"strings"
	"testing"

	logrustest "github.com/sirupsen/logrus/hooks/test"
)

const (
	testSecretPlaceholder = "<BOXLITE_SECRET:k>"
	testSecretValue       = "real-secret-value"
	testSecretHost        = "api.example.com"
)

func headerTestSecrets() []SecretConfig {
	return []SecretConfig{{
		Name: "k", Hosts: []string{testSecretHost},
		Placeholder: testSecretPlaceholder, Headers: map[string]string{"Authorization": "Bearer {value}"}, Value: testSecretValue,
	}}
}

// A declared host that echoes the request must not hand the secret back when
// box code places the placeholder outside the configured header. The echo omits
// Authorization, the configured header, whose echo is the accepted residual risk.
func TestMitmProxy_EchoedPlaceholderDoesNotLeakSecret(t *testing.T) {
	cases := []struct {
		name  string
		build func() *http.Request
	}{
		{"custom header", func() *http.Request {
			req, _ := http.NewRequest("GET", "https://"+testSecretHost+"/", nil)
			req.Header.Set("X-Debug", testSecretPlaceholder)
			return req
		}},
		{"raw query", func() *http.Request {
			req, _ := http.NewRequest("GET", "https://"+testSecretHost+"/", nil)
			req.URL.RawQuery = "key=" + testSecretPlaceholder
			return req
		}},
		{"body", func() *http.Request {
			req, _ := http.NewRequest("POST", "https://"+testSecretHost+"/", strings.NewReader(testSecretPlaceholder))
			return req
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				r.Header.Del("Authorization")
				dump, err := httputil.DumpRequest(r, true)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				w.Write(dump) //nolint:errcheck
			})
			defer cleanup()
			client := dialThroughMITM(t, newTestCA(t), testSecretHost, addr, headerTestSecrets())

			resp, err := client.Do(tc.build())
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(body), testSecretValue) {
				t.Fatalf("guest received the real secret: %q", body)
			}
			if !strings.Contains(string(body), testSecretPlaceholder) {
				t.Fatalf("upstream did not receive the placeholder verbatim: %q", body)
			}
		})
	}
}

// authorizationSeenUpstream sends mutate's request through the proxy and returns
// the Authorization value the upstream received.
func authorizationSeenUpstream(t *testing.T, mutate func(*http.Request)) string {
	t.Helper()
	seen := make(chan string, 1)
	addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Authorization")
	})
	defer cleanup()
	client := dialThroughMITM(t, newTestCA(t), testSecretHost, addr, headerTestSecrets())

	req, err := http.NewRequest("GET", "https://"+testSecretHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	mutate(req)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	return <-seen
}

func TestMitmProxy_InjectsConfiguredHeader(t *testing.T) {
	const want = "Bearer " + testSecretValue
	cases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"overwrites a guest value", func(r *http.Request) { r.Header.Set("Authorization", "Bearer fake") }},
		{"overwrites an empty header", func(r *http.Request) { r.Header.Set("Authorization", "") }},
		{"survives a guest Connection header", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+testSecretPlaceholder)
			r.Header.Set("Connection", "Authorization")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := authorizationSeenUpstream(t, tc.mutate); got != want {
				t.Fatalf("upstream Authorization = %q, want %q", got, want)
			}
		})
	}
}

// Rewrite drops unparsable query parameters unless the proxy restores them.
func TestMitmProxy_KeepsRawQueryVerbatim(t *testing.T) {
	const raw = "a=1;b=2&c=" + testSecretPlaceholder
	seen := make(chan string, 1)
	addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		seen <- r.URL.RawQuery
	})
	defer cleanup()
	client := dialThroughMITM(t, newTestCA(t), testSecretHost, addr, headerTestSecrets())

	req, err := http.NewRequest("GET", "https://"+testSecretHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.URL.RawQuery = raw
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := <-seen; got != raw {
		t.Fatalf("upstream query = %q, want %q", got, raw)
	}
}

// WebSocket handshakes follow the same header-presence rule as HTTP requests.
func TestMitmProxy_InjectsWebSocketHandshake(t *testing.T) {
	for _, present := range []bool{true, false} {
		name := "anonymous"
		if present {
			name = "authenticated"
		}
		t.Run(name, func(t *testing.T) {
			seen := make(chan string, 1)
			addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				seen <- r.Header.Get("Authorization")
				w.Header().Set("Connection", "Upgrade")
				w.Header().Set("Upgrade", "websocket")
				w.WriteHeader(http.StatusSwitchingProtocols)
			})
			defer cleanup()
			client := dialThroughMITM(t, newTestCA(t), testSecretHost, addr, headerTestSecrets())

			req, err := http.NewRequest("GET", "https://"+testSecretHost+"/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
			if present {
				req.Header.Set("Authorization", "Bearer fake")
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("status = %d, want 101", resp.StatusCode)
			}
			want := ""
			if present {
				want = "Bearer " + testSecretValue
			}
			if got := <-seen; got != want {
				t.Fatalf("upstream Authorization = %q, want %q", got, want)
			}
		})
	}
}

// A value net/http refuses to send fails the request without reaching logs.
func TestMitmProxy_InvalidSecretValueIsNotLogged(t *testing.T) {
	const value = "line-one\r\nline-two"
	hook := logrustest.NewGlobal()
	defer hook.Reset()

	addr, cleanup := startTestUpstream(t, func(http.ResponseWriter, *http.Request) {
		t.Error("upstream must not receive the request")
	})
	defer cleanup()
	secrets := []SecretConfig{{Name: "k", Hosts: []string{testSecretHost}, Placeholder: testSecretPlaceholder, Headers: map[string]string{"Authorization": "Bearer {value}"}, Value: value}}
	client := dialThroughMITM(t, newTestCA(t), testSecretHost, addr, secrets)

	req, err := http.NewRequest("GET", "https://"+testSecretHost+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer fake")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if len(hook.AllEntries()) == 0 {
		t.Fatal("expected the upstream error to be logged")
	}
	for _, entry := range hook.AllEntries() {
		line, err := entry.String()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(line, "line-one") || strings.Contains(line, "line-two") {
			t.Fatalf("log entry contains the secret value: %q", line)
		}
	}
}
