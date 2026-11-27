package fetch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/boxlite-ai/secret-server/internal/encryption"
)

const org = "11111111-1111-1111-1111-111111111111"
const first = "22222222-2222-2222-2222-222222222222"
const second = "33333333-3333-3333-3333-333333333333"
const credential = "44444444-4444-4444-4444-444444444444"

type verifierFunc func(context.Context, http.Header) (attest.RunnerID, error)

func (f verifierFunc) Verify(c context.Context, h http.Header) (attest.RunnerID, error) {
	return f(c, h)
}

type memoryStore struct {
	rows              map[string]secret
	audits            []audit
	loadErr, auditErr error
	mu                sync.Mutex
	loads             int
}

func (s *memoryStore) load(context.Context, []string) (map[string]secret, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loads++
	return s.rows, s.loadErr
}
func (s *memoryStore) record(ctx context.Context, entries ...audit) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.audits = append(s.audits, entries...)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return s.auditErr
}
func active() authorization {
	return authorization{true, credential, "runner-a", "box-a", org, []grant{{first}, {second}}, time.Now().Add(time.Minute)}
}
func cipherForTest(t *testing.T) *encryption.Cipher {
	t.Helper()
	p, e := encryption.NewEnvKeyProvider("env:test", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if e != nil {
		t.Fatal(e)
	}
	c, e := encryption.NewCipher(p)
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func encrypted(t *testing.T, c *encryption.Cipher, id string) secret {
	t.Helper()
	s := secret{ID: id, OrganizationID: org, Scope: "org", Name: "KEY_" + id[:1], Hosts: []string{"api.example.com"}, Headers: map[string]string{"Authorization": "Bearer {value}"}, Placeholder: "placeholder-marker"}
	e, err := c.Encrypt(context.Background(), encryption.SecretContext{OrganizationID: org, SecretID: id, Version: 1, Hosts: s.Hosts, Headers: s.Headers}, []byte("plaintext-marker-"+id))
	if err != nil {
		t.Fatal(err)
	}
	s.Ciphertext = `\x` + hex.EncodeToString(e.Ciphertext)
	s.EncryptedDEK = `\x` + hex.EncodeToString(e.WrappedDEK.Ciphertext)
	s.KeyID = e.WrappedDEK.KeyID
	return s
}
func setup(t *testing.T, serve http.HandlerFunc) (*Handler, *memoryStore, *bytes.Buffer) {
	t.Helper()
	api := httptest.NewServer(serve)
	t.Cleanup(api.Close)
	client, e := newClient(api.URL + "/internal/v1/credentials/introspect")
	if e != nil {
		t.Fatal(e)
	}
	c := cipherForTest(t)
	s := &memoryStore{rows: map[string]secret{first: encrypted(t, c, first), second: encrypted(t, c, second)}}
	log := new(bytes.Buffer)
	v := verifierFunc(func(_ context.Context, h http.Header) (attest.RunnerID, error) {
		if h.Get("X-Proof") != "proof-marker" {
			return "", attest.ErrInvalidProof
		}
		return "runner-a", nil
	})
	return &Handler{verifier: v, cipher: c, api: client, store: s, logger: slog.New(slog.NewTextHandler(log, nil)), slots: make(chan struct{}, 16), auditSlots: make(chan struct{}, 16)}, s, log
}
func call(h http.Handler, body string, proof bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/internal/v1/fetch", strings.NewReader(body))
	if proof {
		r.Header.Set("X-Proof", "proof-marker")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

const requestBody = `{"credential":"credential-marker"}`

func TestFetchOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name         string
		mutate       func(*Handler, *memoryStore, *authorization)
		status       int
		code, result string
	}{
		{"success", func(*Handler, *memoryStore, *authorization) {}, 200, "", "ok"},
		{"empty", func(_ *Handler, _ *memoryStore, a *authorization) { a.Grants = []grant{} }, 200, "", "ok"},
		{"inactive", func(_ *Handler, _ *memoryStore, a *authorization) { *a = authorization{} }, 401, "credential_invalid", "credential_invalid"},
		{"runner", func(_ *Handler, _ *memoryStore, a *authorization) { a.RunnerID = "other" }, 401, "credential_invalid", "runner_mismatch"},
		{"org", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			r.OrganizationID = first
			s.rows[second] = r
		}, 401, "credential_invalid", "scope_mismatch"},
		{"box", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			r.Scope = "box"
			box := "other"
			r.BoxID = &box
			s.rows[second] = r
		}, 401, "credential_invalid", "scope_mismatch"},
		{"allowed_box", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			r.Scope = "box"
			box := "box-a"
			r.BoxID = &box
			s.rows[second] = r
		}, 200, "", "ok"},
		{"missing", func(_ *Handler, s *memoryStore, _ *authorization) { delete(s.rows, second) }, 409, "secret_unavailable", "not_found"},
		{"disabled", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			now := "now"
			r.DisabledAt = &now
			s.rows[second] = r
		}, 409, "secret_unavailable", "disabled"},
		{"tampered_second", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			r.Hosts = []string{"evil.example.com"}
			s.rows[second] = r
		}, 503, "decrypt_failed", "decrypt_failed"},
		{"bad_envelope", func(_ *Handler, s *memoryStore, _ *authorization) {
			r := s.rows[second]
			r.Ciphertext = "invalid"
			s.rows[second] = r
		}, 503, "decrypt_failed", "decrypt_failed"},
		{"database", func(_ *Handler, s *memoryStore, _ *authorization) { s.loadErr = errors.New("private-db-marker") }, 503, "store_unavailable", "store_unavailable"},
		{"audit_failure", func(_ *Handler, s *memoryStore, _ *authorization) { s.auditErr = errors.New("private-db-marker") }, 200, "", "ok"},
		{"proof_invalid", func(h *Handler, _ *memoryStore, _ *authorization) {
			h.verifier = verifierFunc(func(context.Context, http.Header) (attest.RunnerID, error) { return "", attest.ErrInvalidProof })
		}, 401, "attestation_failed", "attestation_failed"},
		{"verifier_outage", func(h *Handler, _ *memoryStore, _ *authorization) {
			h.verifier = verifierFunc(func(context.Context, http.Header) (attest.RunnerID, error) { return "", errors.New("proof-marker") })
		}, 503, "attestation_unavailable", "attestation_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := active()
			calls := 0
			h, s, logs := setup(t, func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil || body["token"] != "credential-marker" || body["runner_id"] != "runner-a" {
					t.Error("invalid introspection request")
				}
				_ = json.NewEncoder(w).Encode(a)
			})
			tc.mutate(h, s, &a)
			w := call(h, requestBody, true)
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Error("cacheable response")
			}
			if tc.status != 200 {
				var p map[string]any
				_ = json.Unmarshal(w.Body.Bytes(), &p)
				if p["code"] != tc.code {
					t.Errorf("problem: %v", p)
				}
				if strings.Contains(w.Body.String(), "plaintext-marker") {
					t.Fatal("partial plaintext")
				}
			} else {
				var body struct {
					Secrets []value `json:"secrets"`
				}
				if json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body.Secrets) != len(a.Grants) {
					t.Fatal("wrong response")
				}
				for _, v := range body.Secrets {
					if !strings.HasPrefix(v.Value, "plaintext-marker-") {
						t.Fatal("wrong plaintext")
					}
				}
			}
			if strings.Contains(w.Body.String(), "version") {
				t.Error("version in response")
			}
			if len(s.audits) == 0 || s.audits[0].Result != tc.result {
				t.Fatalf("audit: %+v", s.audits)
			}
			if tc.name == "proof_invalid" || tc.name == "verifier_outage" {
				if calls != 0 || s.audits[0].RunnerID != "" {
					t.Error("failed identity reached API")
				}
			}
			if tc.name == "runner" && s.loads != 0 {
				t.Error("runner mismatch reached storage")
			}
			if tc.name == "audit_failure" && h.AuditFailures() != 2 {
				t.Error("missing audit counter")
			}
			for _, marker := range []string{"plaintext-marker", "credential-marker", "proof-marker", "placeholder-marker", "private-db-marker"} {
				if strings.Contains(logs.String(), marker) {
					t.Errorf("log leaked %s", marker)
				}
			}
		})
	}
}
func TestSingleUseAndFailureStillConsume(t *testing.T) {
	for _, tamper := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "decrypt_failure"}[tamper], func(t *testing.T) {
			var used atomic.Bool
			h, s, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
				if used.Swap(true) {
					_, _ = io.WriteString(w, `{"active":false}`)
					return
				}
				_ = json.NewEncoder(w).Encode(active())
			})
			if tamper {
				r := s.rows[second]
				r.Hosts = []string{"wrong"}
				s.rows[second] = r
			}
			w := call(h, requestBody, true)
			if (!tamper && w.Code != 200) || (tamper && w.Code != 503) {
				t.Fatal(w.Code)
			}
			w = call(h, requestBody, true)
			if w.Code != 401 {
				t.Fatal("replay accepted", w.Code)
			}
		})
	}
}
func TestMalformedRequestsAndMissingProof(t *testing.T) {
	calls := 0
	h, _, _ := setup(t, func(http.ResponseWriter, *http.Request) { calls++ })
	for _, b := range []string{"", `{}`, `null`, `{"credential":"x","runner_id":"forged"}`, requestBody + `{}`, `{"credential":"` + strings.Repeat("x", 4096) + `"}`} {
		if w := call(h, b, true); w.Code != 401 {
			t.Errorf("invalid request accepted %d", w.Code)
		}
	}
	if w := call(h, requestBody, false); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if calls != 0 {
		t.Fatal("invalid input consumed credential")
	}
}
func TestSaturationAndAuditAdmission(t *testing.T) {
	h, s, _ := setup(t, func(http.ResponseWriter, *http.Request) { t.Error("API called") })
	for range cap(h.slots) {
		h.slots <- struct{}{}
	}
	if w := call(h, requestBody, true); w.Code != 503 || s.audits[0].Result != "store_unavailable" {
		t.Fatal(w.Code)
	}
	for range cap(h.auditSlots) {
		h.auditSlots <- struct{}{}
	}
	if w := call(h, requestBody, true); w.Code != 503 || h.AuditFailures() != 1 {
		t.Fatal("unbounded audit admission")
	}
}
func TestAuditSurvivesCancellation(t *testing.T) {
	h, s, _ := setup(t, func(http.ResponseWriter, *http.Request) {})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.record(ctx, audit{Result: "credential_invalid"})
	if len(s.audits) != 1 || h.AuditFailures() != 0 {
		t.Fatal("audit inherited cancellation")
	}
}

func TestAllOwnershipChecksPrecedeDecrypt(t *testing.T) {
	h, s, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(active()) })
	r := s.rows[first]
	r.Ciphertext = "invalid"
	s.rows[first] = r
	r = s.rows[second]
	r.OrganizationID = first
	s.rows[second] = r
	w := call(h, requestBody, true)
	if w.Code != 401 || s.audits[0].Result != "scope_mismatch" {
		t.Fatalf("decrypted before checking all ownership: %d %+v", w.Code, s.audits)
	}
}
func TestConcurrentSingleUse(t *testing.T) {
	var used atomic.Bool
	var calls atomic.Int32
	h, s, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if used.Swap(true) {
			_, _ = io.WriteString(w, `{"active":false}`)
		} else {
			_ = json.NewEncoder(w).Encode(active())
		}
	})
	h.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	start := make(chan struct{})
	results := make(chan int, 2)
	for range 2 {
		go func() { <-start; results <- call(h, requestBody, true).Code }()
	}
	close(start)
	a, b := <-results, <-results
	if !((a == 200 && b == 401) || (a == 401 && b == 200)) || calls.Load() != 2 {
		t.Fatalf("concurrent results %d %d", a, b)
	}
	if len(s.audits) != 3 {
		t.Fatalf("audit count %d", len(s.audits))
	}
}
func TestRoutesAndConstructor(t *testing.T) {
	h, _, _ := setup(t, func(http.ResponseWriter, *http.Request) { t.Error("API called") })
	for _, tc := range []struct {
		method, path string
		status       int
	}{{"GET", "/internal/v1/fetch", 405}, {"POST", "/other", 404}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatal(w.Code)
		}
	}
	if _, err := New(nil, h.cipher, h.verifier, "http://localhost", h.logger); err == nil {
		t.Fatal("nil pool accepted")
	}
}

func TestAggregateResponseLimit(t *testing.T) {
	a := active()
	a.Grants = nil
	h, s, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(a) })
	for i := range 64 {
		id := fmt.Sprintf("%08x-0000-0000-0000-000000000000", i)
		row := encrypted(t, h.cipher, id)
		envelope, err := h.cipher.Encrypt(context.Background(), encryption.SecretContext{OrganizationID: org, SecretID: id, Version: 1, Hosts: row.Hosts, Headers: row.Headers}, bytes.Repeat([]byte{1}, 60000))
		if err != nil {
			t.Fatal(err)
		}
		row.Ciphertext = `\x` + hex.EncodeToString(envelope.Ciphertext)
		row.EncryptedDEK = `\x` + hex.EncodeToString(envelope.WrappedDEK.Ciphertext)
		s.rows[id] = row
		a.Grants = append(a.Grants, grant{id})
	}
	w := call(h, requestBody, true)
	if w.Code != 503 || strings.Contains(w.Body.String(), "value") || s.audits[0].Result != "store_unavailable" {
		t.Fatalf("oversized response: %d %s", w.Code, w.Body)
	}
}
func TestRequestSizeBoundary(t *testing.T) {
	calls := 0
	h, _, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { calls++; _, _ = io.WriteString(w, `{"active":false}`) })
	for _, size := range []int{4096, 4097} {
		before := calls
		body := requestBody + strings.Repeat(" ", size-len(requestBody))
		w := call(h, body, true)
		if w.Code != 401 {
			t.Fatal(w.Code)
		}
		if (calls > before) != (size == 4096) {
			t.Fatalf("size %d API calls %d", size, calls-before)
		}
	}
}
