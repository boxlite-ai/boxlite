// Package fetch redeems runner-bound credentials for authorized secret values.
package fetch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler is mounted at /internal/v1/fetch only for the fetch and all roles.
// The caller owns the pool, startup key verification and verifier configuration.
type Handler struct {
	verifier          attest.Verifier
	cipher            *encryption.Cipher
	api               *apiClient
	store             store
	logger            *slog.Logger
	slots, auditSlots chan struct{}
	auditFailures     atomic.Uint64
}

// New validates dependencies and the full internal introspection endpoint URL.
func New(pool *pgxpool.Pool, cipher *encryption.Cipher, verifier attest.Verifier, endpoint string, logger *slog.Logger) (*Handler, error) {
	if pool == nil || cipher == nil || verifier == nil || logger == nil {
		return nil, errors.New("fetch dependencies are required")
	}
	client, err := newClient(endpoint)
	if err != nil {
		return nil, err
	}
	return &Handler{verifier: verifier, cipher: cipher, api: client, store: postgres{pool}, logger: logger, slots: make(chan struct{}, 16), auditSlots: make(chan struct{}, 16)}, nil
}

// AuditFailures is a monotonic counter for failed or admission-rejected audit rows.
func (h *Handler) AuditFailures() uint64 { return h.auditFailures.Load() }

type value struct {
	Name        string            `json:"name"`
	Value       string            `json:"value"`
	Hosts       []string          `json:"hosts"`
	Headers     map[string]string `json:"headers"`
	Placeholder string            `json:"placeholder"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a := audit{Result: "credential_invalid"}
	start := time.Now()
	defer func() {
		h.logger.Info("secret fetch", "runner_id", a.RunnerID, "credential_id", a.CredentialID, "box_id", a.BoxID, "result", a.Result, "latency", time.Since(start))
	}()
	fail := func(status int, code, result, name string) {
		a.Result = result
		h.record(r.Context(), a)
		problem(w, status, code, name)
	}
	if r.URL.Path != "/internal/v1/fetch" {
		fail(404, "not_found", "credential_invalid", "")
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		fail(405, "method_not_allowed", "credential_invalid", "")
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		fail(503, "store_unavailable", "store_unavailable", "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	runner, err := h.verifier.Verify(ctx, r.Header)
	if err != nil || runner == "" {
		if err != nil && !errors.Is(err, attest.ErrInvalidProof) {
			fail(503, "attestation_unavailable", "attestation_unavailable", "")
		} else {
			fail(401, "attestation_failed", "attestation_failed", "")
		}
		return
	}
	a.RunnerID = string(runner)
	var request struct {
		Credential string `json:"credential"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.Credential == "" {
		fail(401, "credential_invalid", "credential_invalid", "")
		return
	}
	auth, err := h.api.consume(ctx, request.Credential, string(runner))
	if err != nil {
		fail(503, "api_unavailable", "api_unavailable", "")
		return
	}
	if !auth.Active {
		fail(401, "credential_invalid", "credential_invalid", "")
		return
	}
	a.CredentialID = auth.CredentialID
	a.BoxID = auth.BoxID
	if auth.RunnerID != string(runner) {
		fail(401, "credential_invalid", "runner_mismatch", "")
		return
	}
	ids := make([]string, len(auth.Grants))
	for i, g := range auth.Grants {
		ids[i] = g.SecretID
	}
	secrets, err := h.store.load(ctx, ids)
	if err != nil {
		fail(503, "store_unavailable", "store_unavailable", "")
		return
	}
	for _, id := range ids {
		a.SecretID = id
		s, ok := secrets[id]
		if !ok {
			fail(409, "secret_unavailable", "not_found", "")
			return
		}
		if s.OrganizationID != auth.OrganizationID || (s.Scope == "org" && s.BoxID != nil) || (s.Scope == "box" && (s.BoxID == nil || *s.BoxID != auth.BoxID)) || (s.Scope != "org" && s.Scope != "box") {
			fail(401, "credential_invalid", "scope_mismatch", "")
			return
		}
		if s.DisabledAt != nil {
			fail(409, "secret_unavailable", "disabled", s.Name)
			return
		}
	}
	response := struct {
		BoxID   string  `json:"box_id"`
		Secrets []value `json:"secrets"`
	}{auth.BoxID, make([]value, 0, len(ids))}
	for _, id := range ids {
		a.SecretID = id
		s := secrets[id]
		envelope, err := s.envelope()
		if err != nil {
			fail(503, "decrypt_failed", "decrypt_failed", "")
			return
		}
		plaintext, err := h.cipher.Decrypt(ctx, encryption.SecretContext{OrganizationID: s.OrganizationID, SecretID: s.ID, Version: 1, Hosts: s.Hosts, Headers: s.Headers}, envelope)
		if err != nil {
			fail(503, "decrypt_failed", "decrypt_failed", "")
			return
		}
		response.Secrets = append(response.Secrets, value{s.Name, string(plaintext), s.Hosts, s.Headers, s.Placeholder})
		clear(plaintext)
	}
	body, err := json.Marshal(response)
	if err != nil || len(body) > 8<<20 || ctx.Err() != nil {
		fail(503, "store_unavailable", "store_unavailable", "")
		return
	}
	a.Result = "ok"
	a.SecretID = ""
	entries := make([]audit, 0, max(1, len(ids)))
	if len(ids) == 0 {
		entries = append(entries, a)
	}
	for _, id := range ids {
		a.SecretID = id
		entries = append(entries, a)
	}
	h.record(ctx, entries...)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func (h *Handler) record(ctx context.Context, entries ...audit) {
	select {
	case h.auditSlots <- struct{}{}:
		defer func() { <-h.auditSlots }()
	default:
		h.auditFailure(len(entries))
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 100*time.Millisecond)
	defer cancel()
	for _, a := range entries {
		if h.store.record(ctx, a) != nil {
			h.auditFailure(1)
		}
	}
}
func (h *Handler) auditFailure(count int) {
	h.auditFailures.Add(uint64(count))
	h.logger.Error("secret fetch audit write failed")
}
func problem(w http.ResponseWriter, status int, code, name string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Code   string `json:"code"`
		Name   string `json:"name,omitempty"`
	}{"about:blank", http.StatusText(status), status, code, name})
}
