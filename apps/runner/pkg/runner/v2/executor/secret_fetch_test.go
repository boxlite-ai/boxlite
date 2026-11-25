// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"cloud.google.com/go/compute/metadata"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/backend"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const credentialMarker = "bxsc_CREDENTIAL_MARKER"
const identityMarker = "IDENTITY_MARKER"

type secretBackend struct {
	backend.BoxBackend
	exists    bool
	lookupErr error
	createErr error
	created   []dto.CreateBoxDTO
}

func (b *secretBackend) BoxExists(context.Context, string) (bool, error) {
	return b.exists, b.lookupErr
}
func (b *secretBackend) Create(_ context.Context, box dto.CreateBoxDTO) (string, string, error) {
	b.created = append(b.created, box)
	if b.createErr == nil {
		b.exists = true
	}
	return "native-1", "boxlite", b.createErr
}

func secretJob(t *testing.T, credential bool, secrets any) *apiclient.Job {
	t.Helper()
	payload := map[string]any{"id": "box-1", "secrets": secrets}
	if credential {
		payload["secretCredential"] = map[string]any{"token": credentialMarker, "expiresAt": "2026-01-01T00:00:00Z"}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(raw)
	return &apiclient.Job{Id: "job-1", ResourceType: "BOX", ResourceId: "box-1", Type: apiclient.JOBTYPE_CREATE_BOX, Payload: &encoded}
}

func requestedSecrets() []map[string]any { return []map[string]any{{"name": "A"}, {"name": "B"}} }
func returnedSecrets() []dto.SecretDTO {
	return []dto.SecretDTO{
		{Name: "B", Value: "VALUE_B_MARKER", Hosts: []string{"b.example"}, Headers: map[string]string{"X-Key": "{value}"}, Placeholder: "PLACEHOLDER_B_MARKER"},
		{Name: "A", Value: "VALUE_A_MARKER", Hosts: []string{"a.example"}, Headers: map[string]string{"Authorization": "Bearer {value}"}, Placeholder: "PLACEHOLDER_A_MARKER"},
	}
}

func secretExecutor(b *secretBackend, f *secretFetcher) *Executor {
	return &Executor{backend: b, secretFetcher: f, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestSecretCredentialFetchAndReplay(t *testing.T) {
	var fetches, identities atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		if r.Method != "POST" || r.URL.Path != "/internal/v1/fetch" || r.Header.Get("Content-Type") != "application/json" ||
			r.Header.Get("Authorization") != "Bearer "+identityMarker || r.Header.Get("X-Boxlite-Runner-Identity") != identityMarker {
			t.Error("incorrect fetch request")
		}
		var body map[string]string
		if json.NewDecoder(r.Body).Decode(&body) != nil || !reflect.DeepEqual(body, map[string]string{"credential": credentialMarker}) {
			t.Error("incorrect fetch body")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"box_id": "box-1", "secrets": returnedSecrets()})
	}))
	defer server.Close()
	metadataServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identities.Add(1)
		if r.URL.Path != "/computeMetadata/v1/instance/service-accounts/default/identity" || r.URL.Query().Get("audience") != server.URL ||
			r.URL.Query().Get("format") != "full" || r.Header.Get("Metadata-Flavor") != "Google" {
			t.Error("incorrect metadata request")
		}
		_, _ = io.WriteString(w, identityMarker)
	}))
	defer metadataServer.Close()
	t.Setenv("GCE_METADATA_HOST", strings.TrimPrefix(metadataServer.URL, "http://"))
	f := newSecretFetcher(server.URL, "gcp_iit")
	f.metadata = metadata.NewClient(metadataServer.Client())
	b := &secretBackend{}
	e := secretExecutor(b, f)
	// Concurrent replay must observe the box created by the first job.
	var workers sync.WaitGroup
	for range 2 {
		job := secretJob(t, true, requestedSecrets())
		workers.Add(1)
		go func() {
			defer workers.Done()
			if _, err := e.executeJob(context.Background(), job); err != nil {
				t.Error(err)
			}
			if job.Payload != nil {
				t.Error("credential payload retained")
			}
		}()
	}
	workers.Wait()
	if fetches.Load() != 1 || identities.Load() != 1 || len(b.created) != 2 {
		t.Fatalf("fetch=%d identity=%d creates=%d", fetches.Load(), identities.Load(), len(b.created))
	}
	want := returnedSecrets()
	want[0], want[1] = want[1], want[0]
	if !reflect.DeepEqual(b.created[0].Secrets, want) {
		t.Fatal("authoritative values/policies were not hydrated in payload order")
	}
	if !b.created[1].RequireExisting || len(b.created[1].Secrets) != 0 {
		t.Fatal("replay lacks adoption-only guard")
	}
}

func TestSecretCredentialWireValidationAndInline(t *testing.T) {
	for _, tc := range []struct {
		name       string
		credential bool
		secrets    any
		valid      bool
	}{
		{"inline", false, []map[string]any{{"name": "A", "value": "inline"}}, true},
		{"omitted inline value", false, requestedSecrets(), true},
		{"credential omitted value", true, requestedSecrets(), true},
		{"credential empty value", true, []map[string]any{{"name": "A", "value": ""}}, false},
		{"credential null value", true, []map[string]any{{"name": "A", "value": nil}}, false},
		{"credential supplied value", true, []map[string]any{{"name": "A", "value": "inline"}}, false},
		{"duplicate names", true, []map[string]any{{"name": "A"}, {"name": "A"}}, false},
		{"empty credential name", true, []map[string]any{{"name": ""}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &secretBackend{exists: true}
			e := secretExecutor(b, nil) // A replay must work without any fetch configuration.
			_, err := e.executeJob(context.Background(), secretJob(t, tc.credential, tc.secrets))
			if (err == nil) != tc.valid || (len(b.created) > 0) != tc.valid {
				t.Fatalf("valid=%v err=%v creates=%d", tc.valid, err, len(b.created))
			}
			if tc.name == "inline" && b.created[0].Secrets[0].Value != "inline" {
				t.Fatal("inline value changed")
			}
		})
	}
	for _, change := range []string{"resource mismatch", "empty token", "lookup failure"} {
		t.Run(change, func(t *testing.T) {
			job := secretJob(t, true, requestedSecrets())
			b := &secretBackend{}
			switch change {
			case "resource mismatch":
				job.ResourceId = "other"
			case "empty token":
				*job.Payload = strings.ReplaceAll(*job.Payload, credentialMarker, "")
			case "lookup failure":
				b.lookupErr = errors.New("PRIVATE_MARKER")
			}
			_, err := secretExecutor(b, nil).executeJob(context.Background(), job)
			if err == nil || strings.Contains(err.Error(), "PRIVATE_MARKER") || len(b.created) != 0 {
				t.Fatal("unsafe validation failure")
			}
		})
	}
}

type metadataFunc func(context.Context, string) (string, error)

func TestInlineSecretCompatibility(t *testing.T) {
	for _, scenario := range []string{"empty name", "duplicate names", "empty value"} {
		t.Run(scenario, func(t *testing.T) {
			secrets := returnedSecrets()
			switch scenario {
			case "empty name":
				secrets[0].Name = ""
			case "duplicate names":
				secrets[0].Name = secrets[1].Name
			case "empty value":
				secrets[0].Value = ""
			}
			b := &secretBackend{}
			_, err := secretExecutor(b, nil).executeJob(t.Context(), secretJob(t, false, secrets))
			if err != nil {
				t.Fatalf("inline request rejected before backend: %v", err)
			}
			if len(b.created) != 1 || !reflect.DeepEqual(b.created[0].Secrets, secrets) || b.created[0].RequireExisting {
				t.Fatalf("inline request changed: %+v", b.created)
			}
		})
	}
}

func (f metadataFunc) GetWithContext(ctx context.Context, path string) (string, error) {
	return f(ctx, path)
}
func fixedIdentity() metadataGetter {
	return metadataFunc(func(ctx context.Context, _ string) (string, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 5*time.Second {
			return "", errors.New("missing budget")
		}
		return identityMarker, nil
	})
}

func TestSecretCredentialMissingPrerequisites(t *testing.T) {
	for _, missing := range []string{"lookup capability", "fetch configuration", "identity"} {
		t.Run(missing, func(t *testing.T) {
			var fetches, identities atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fetches.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer server.Close()
			f := newSecretFetcher(server.URL, "")
			f.metadata = metadataFunc(func(context.Context, string) (string, error) {
				identities.Add(1)
				return " \n\t", nil
			})
			b := &secretBackend{}
			e := secretExecutor(b, f)
			want := "attestation_failed"
			wantIdentities := int32(1)
			switch missing {
			case "lookup capability":
				// Expose only BoxBackend, hiding the optional BoxExists capability.
				e.backend = struct{ backend.BoxBackend }{b}
				want, wantIdentities = "local box lookup unavailable", 0
			case "fetch configuration":
				e.secretFetcher = nil
				want, wantIdentities = "secret server configuration unavailable", 0
			}
			job := secretJob(t, true, requestedSecrets())
			_, err := e.executeJob(context.Background(), job)
			if err == nil || err.Error() != want {
				t.Fatalf("error = %v, want %q", err, want)
			}
			if fetches.Load() != 0 || identities.Load() != wantIdentities || len(b.created) != 0 {
				t.Fatalf("fetches=%d identities=%d creates=%d", fetches.Load(), identities.Load(), len(b.created))
			}
			if job.Payload != nil {
				t.Fatal("failed job retained credential payload")
			}
		})
	}
}

func TestSecretCredentialExecutorConfiguration(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-runner-token")
	t.Setenv("SECRET_SERVER_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_ATTESTOR", "dev")
	b := &secretBackend{}
	e, err := NewExecutor(&ExecutorConfig{Backend: b, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	// Construction must wire the environment into the actual create path.
	_, err = e.executeJob(context.Background(), secretJob(t, true, requestedSecrets()))
	if err == nil || err.Error() != "unsupported runner attestor" || len(b.created) != 0 {
		t.Fatalf("unsupported configured attestor: error=%v creates=%d", err, len(b.created))
	}
}

func TestSecretCredentialResponseValidation(t *testing.T) {
	for _, damage := range []string{"wrong box", "missing", "extra", "different name", "duplicate", "empty value", "missing headers", "malformed", "oversized"} {
		t.Run(damage, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				secrets := returnedSecrets()
				boxID := "box-1"
				switch damage {
				case "wrong box":
					boxID = "other"
				case "missing":
					secrets = secrets[:1]
				case "extra":
					secrets = append(secrets, dto.SecretDTO{Name: "C", Value: "extra", Headers: map[string]string{"X-Key": "{value}"}})
				case "duplicate":
					secrets[1] = secrets[0]
				case "different name":
					secrets[0].Name = "C"
				case "empty value":
					secrets[0].Value = ""
				case "missing headers":
					secrets[0].Headers = nil
				case "malformed":
					_, _ = io.WriteString(w, "{SENSITIVE_MARKER")
					return
				case "oversized":
					_, _ = io.WriteString(w, strings.Repeat("X", 1024*1024+1))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"box_id": boxID, "secrets": secrets})
			}))
			defer server.Close()
			f := newSecretFetcher(server.URL, "")
			f.metadata = fixedIdentity()
			b := &secretBackend{}
			_, err := secretExecutor(b, f).executeJob(context.Background(), secretJob(t, true, requestedSecrets()))
			if err == nil || calls.Load() != 1 || len(b.created) != 0 || strings.Contains(err.Error(), "MARKER") {
				t.Fatalf("calls=%d creates=%d err=%v", calls.Load(), len(b.created), err)
			}
		})
	}
}

func TestSecretCredentialFetchResponseSize(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		ok   bool
	}{
		{"above former limit", 1<<20 + 1, true},
		{"at server limit", 8 << 20, true},
		{"above server limit", 8<<20 + 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const prefix = `{"box_id":"box-1","secrets":[{"name":"A","value":"sample","hosts":["example.com"],"headers":{"Authorization":"Bearer {value}"},"placeholder":"`
			const suffix = `"}]}`
			// Pad the JSON with valid trailing whitespace so the fixture does not
			// rely on a secret value larger than the server allows.
			const body = prefix + "placeholder" + suffix
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.WriteString(w, body)
				_, _ = io.WriteString(w, strings.Repeat(" ", tc.size-len(body)))
			}))
			defer server.Close()
			f := newSecretFetcher(server.URL, "")
			f.metadata = fixedIdentity()
			b := &secretBackend{}
			_, err := secretExecutor(b, f).executeJob(t.Context(), secretJob(t, true, []map[string]string{{"name": "A"}}))
			if !tc.ok {
				if err == nil || err.Error() != "invalid secret fetch response" || len(b.created) != 0 {
					t.Fatalf("oversize response: err=%v creates=%d", err, len(b.created))
				}
			} else if err != nil || len(b.created) != 1 || len(b.created[0].Secrets) != 1 || b.created[0].Secrets[0].Value != "sample" {
				t.Fatalf("valid response: err=%v creates=%d", err, len(b.created))
			}
			if got := calls.Load(); got != 1 {
				t.Fatalf("fetch requests=%d, want 1", got)
			}
		})
	}
}

func TestSecretCredentialErrorsThroughExecute(t *testing.T) {
	for _, code := range []string{"attestation_failed", "credential_invalid", "secret_unavailable", "api_unavailable", "decrypt_failed", "secret_store_unavailable", "UNKNOWN_MARKER", "backend", "malformed payload", "metadata"} {
		t.Run(code, func(t *testing.T) {
			var logs bytes.Buffer
			reported := make(chan string, 16)
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				reported <- string(raw)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":"job-1","type":"CREATE_BOX","status":"FAILED","resourceType":"BOX","resourceId":"box-1","createdAt":"2026-01-01T00:00:00Z"}`)
			}))
			defer api.Close()
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if code == "backend" {
					_ = json.NewEncoder(w).Encode(map[string]any{"box_id": "box-1", "secrets": returnedSecrets()})
					return
				}
				status := 503
				if code == "attestation_failed" || code == "credential_invalid" {
					status = 401
				}
				if code == "secret_unavailable" {
					status = 409
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "detail": "BODY_MARKER " + credentialMarker + identityMarker})
			}))
			defer server.Close()
			f := newSecretFetcher(server.URL, "")
			f.metadata = fixedIdentity()
			if code == "metadata" {
				f.metadata = metadataFunc(func(context.Context, string) (string, error) { return "", errors.New("METADATA_MARKER") })
			}
			b := &secretBackend{}
			if code == "backend" {
				b.createErr = errors.New("no space left on device BACKEND_MARKER")
			}
			e := secretExecutor(b, f)
			e.log = slog.New(slog.NewTextHandler(&logs, nil))
			cfg := apiclient.NewConfiguration()
			cfg.Servers = apiclient.ServerConfigurations{{URL: api.URL}}
			e.client = apiclient.NewAPIClient(cfg)
			exporter := tracetest.NewInMemoryExporter()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
			previous := otel.GetTracerProvider()
			otel.SetTracerProvider(provider)
			defer func() { otel.SetTracerProvider(previous); _ = provider.Shutdown(context.Background()) }()
			job := secretJob(t, true, requestedSecrets())
			if code == "malformed payload" {
				*job.Payload = strings.ReplaceAll(*job.Payload, "2026-01-01T00:00:00Z", "EXPIRES_MARKER")
			}
			e.Execute(context.Background(), job)
			if job.Payload != nil {
				t.Fatal("terminal job retained credential payload")
			}
			status := <-reported
			diagnostics := logs.String() + status + fmt.Sprint(exporter.GetSpans())
			if !strings.Contains(status, `"status":"FAILED"`) || strings.Contains(diagnostics, "MARKER") || strings.Contains(strings.ToLower(diagnostics), "recoverable") {
				t.Fatalf("unsafe terminal diagnostics: %s", diagnostics)
			}
			if code != "backend" && code != "malformed payload" && code != "UNKNOWN_MARKER" && code != "metadata" && !strings.Contains(status, code) {
				t.Fatal("lost safe error code")
			}
			want := 1
			if code == "malformed payload" || code == "metadata" {
				want = 0
			}
			if calls.Load() != int32(want) {
				t.Fatalf("fetch count %d", calls.Load())
			}
		})
	}
}

type secretRoundTrip func(*http.Request) (*http.Response, error)

func (f secretRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSecretCredentialConnectionFailureSingleAttempt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("closed server received a request") }))
	server.Close()
	f := newSecretFetcher(server.URL, "")
	f.metadata = fixedIdentity()
	attempts := 0
	f.client.Transport = secretRoundTrip(func(r *http.Request) (*http.Response, error) {
		attempts++
		if r.GetBody != nil {
			t.Error("credential POST can be replayed")
		}
		return http.DefaultTransport.RoundTrip(r)
	})
	_, err := f.fetch(context.Background(), "box-1", credentialMarker, []dto.SecretDTO{{Name: "A"}})
	if err == nil || attempts != 1 {
		t.Fatalf("attempts=%d err=%v", attempts, err)
	}
}

func TestSecretCredentialNeverRetriesNetworkUncertainty(t *testing.T) {
	for _, failure := range []string{"lost response", "partial response", "cancel after dispatch", "timeout", "redirect"} {
		t.Run(failure, func(t *testing.T) {
			budget := time.Second
			if failure == "timeout" {
				budget = 20 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), budget)
			defer cancel()
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				if failure == "cancel after dispatch" || failure == "timeout" {
					if failure == "cancel after dispatch" {
						cancel()
					}
					<-r.Context().Done()
					return
				}
				if failure == "redirect" {
					http.Redirect(w, r, "/repeated", http.StatusTemporaryRedirect)
					return
				}
				connection, buffer, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer connection.Close()
				if failure == "partial response" {
					_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
					_ = buffer.Flush()
				}
			}))
			defer server.Close()
			f := newSecretFetcher(server.URL, "")
			f.metadata = fixedIdentity()
			b := &secretBackend{}
			_, err := secretExecutor(b, f).executeJob(ctx, secretJob(t, true, requestedSecrets()))
			if err == nil || calls.Load() != 1 || len(b.created) != 0 {
				t.Fatalf("fetch=%d creates=%d err=%v", calls.Load(), len(b.created), err)
			}
		})
	}
}

func TestSecretCredentialConfigurationIdentityAndDeadline(t *testing.T) {
	for _, base := range []string{"", ":invalid", "http://example.com", "https://u:p@example.com", "https://example.com?a=b", "https://example.com#fragment"} {
		f := newSecretFetcher(base, "")
		f.metadata = metadataFunc(func(context.Context, string) (string, error) {
			t.Fatal("identity requested with invalid configuration")
			return "", nil
		})
		if _, err := f.fetch(context.Background(), "box-1", credentialMarker, nil); err == nil {
			t.Fatalf("accepted %q", base)
		}
	}
	f := newSecretFetcher("https://example.com", "dev")
	f.metadata = fixedIdentity()
	if _, err := f.fetch(context.Background(), "box-1", credentialMarker, nil); err == nil {
		t.Fatal("accepted unsupported attestor")
	}
	f.attestor = "gcp_iit"
	f.metadata = metadataFunc(func(ctx context.Context, _ string) (string, error) { return "", errors.New("IDENTITY_ERROR_MARKER") })
	if _, err := f.fetch(context.Background(), "box-1", credentialMarker, nil); err == nil || err.Error() != "attestation_failed" {
		t.Fatalf("unsafe identity failure: %v", err)
	}
	f.metadata = metadataFunc(func(ctx context.Context, _ string) (string, error) { <-ctx.Done(); return "", ctx.Err() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := f.fetch(ctx, "box-1", credentialMarker, nil); err == nil {
		t.Fatal("metadata timeout succeeded")
	}
}
