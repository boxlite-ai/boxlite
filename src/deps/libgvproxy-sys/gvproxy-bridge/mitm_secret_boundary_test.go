package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestSubstituteHeaders_AuthenticationHeadersOnly(t *testing.T) {
	const placeholder = "<BOXLITE_SECRET:k>"
	for _, tt := range []struct {
		header string
		want   string
	}{
		{"Authorization", "real-value"},
		{"authorization", "real-value"},
		{"AUTHORIZATION", "real-value"},
		{"aUtHoRiZaTiOn", "real-value"},
		{"X-API-Key", "real-value"},
		{"x-api-key", "real-value"},
		{"Api-Key", "real-value"},
		{"api-key", "real-value"},
		{"X-Authorization", placeholder},
		{"Proxy-Authorization", placeholder},
		{"X-API-Key-Extra", placeholder},
		{"Cookie", placeholder},
		{"Set-Cookie", placeholder},
		{"User-Agent", placeholder},
		{"Referer", placeholder},
		{"Content-Type", placeholder},
	} {
		t.Run(tt.header, func(t *testing.T) {
			// Use the map directly to cover non-canonical header names too.
			req := &http.Request{Header: http.Header{tt.header: []string{placeholder, placeholder}}}
			substituteHeaders(req, testSecrets())
			values := req.Header[tt.header]
			if len(values) != 2 {
				t.Fatalf("header has %d values, want 2", len(values))
			}
			for _, got := range values {
				if got != tt.want {
					t.Errorf("header value = %q, want %q", got, tt.want)
				}
			}
		})
	}
}

// A trusted API can persist guest-controlled content and return it on a later
// request. Only its authentication header should receive the real credential.
func TestMitmProxy_SecretStaysOutOfStoredContent(t *testing.T) {
	const placeholder = "<BOXLITE_SECRET:gh>"
	const secretValue = "dummy-credential-for-local-test"
	secrets := []SecretConfig{{
		Name: "gh", Hosts: []string{"api.example.com"},
		Placeholder: placeholder, Value: secretValue,
	}}
	ca := newTestCA(t)
	for _, protocol := range []string{"http/1.1", "h2"} {
		for _, field := range []string{
			"body", "chunked body", "query", "User-Agent", "Referer",
			"X-Custom", "Cookie", "If-None-Match", "X-Amz-Meta-Token",
		} {
			t.Run(protocol+"/"+field, func(t *testing.T) {
				var mu sync.Mutex
				var stored string
				addr, cleanup := startTestUpstream(t, func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer "+secretValue {
						http.Error(w, "missing credential", http.StatusUnauthorized)
						return
					}
					mu.Lock()
					defer mu.Unlock()
					if r.Method == http.MethodPost {
						switch field {
						case "body", "chunked body":
							body, err := io.ReadAll(r.Body)
							if err != nil {
								http.Error(w, "read failed", http.StatusBadRequest)
								return
							}
							stored = string(body)
						case "query":
							stored = r.URL.Query().Get("body")
						default:
							stored = r.Header.Get(field)
						}
						w.WriteHeader(http.StatusCreated)
						return
					}
					io.WriteString(w, stored)
				})
				defer cleanup()
				client := dialThroughMITMWithProto(t, ca, "api.example.com", addr, secrets, protocol)
				defer client.CloseIdleConnections()

				endpoint := "https://api.example.com/comments"
				content := placeholder
				if field == "body" || field == "chunked body" {
					content = fmt.Sprintf(`{"body":%q}`, placeholder)
				}
				if field == "query" {
					endpoint += "?body=" + placeholder
				}
				req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(content))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+placeholder)
				switch field {
				case "chunked body":
					req.ContentLength = -1
				case "body", "query":
				default:
					req.Header.Set(field, placeholder)
				}
				resp, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != http.StatusCreated {
					t.Fatalf("write status = %d, want 201", resp.StatusCode)
				}

				req, err = http.NewRequest(http.MethodGet, "https://api.example.com/comments", nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+placeholder)
				resp, err = client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				got, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("read status = %d, want 200", resp.StatusCode)
				}
				if strings.Contains(string(got), secretValue) {
					t.Fatal("credential leaked through stored guest content")
				}
				if string(got) != content {
					t.Errorf("stored content = %q, want unchanged %q", got, content)
				}
			})
		}
	}
}
