package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"slices"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/secretstore"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxTransferBody = 1 << 20
	metadataTimeout = 2 * time.Second
)

type writeAPI struct {
	pool   *pgxpool.Pool
	cipher *encryption.Cipher
}

func writeRoutes(pool *pgxpool.Pool, cipher *encryption.Cipher) http.Handler {
	a := &writeAPI{pool: pool, cipher: cipher}
	mux := http.NewServeMux()
	const transferPath = "/internal/v1/boxes/{box_id}/secrets"
	const metadataPath = "/internal/v1/secrets/{secret_id}"
	mux.HandleFunc("POST "+transferPath, a.transfer)
	mux.HandleFunc("GET "+metadataPath, a.metadata)
	mux.HandleFunc(transferPath, writeMethodNotAllowed("POST"))
	mux.HandleFunc(metadataPath, writeMethodNotAllowed("GET, HEAD"))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { problem(w, http.StatusNotFound, "not_found") })
	return mux
}

func writeMethodNotAllowed(allow string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", allow)
		problem(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func writeProblem(w http.ResponseWriter, e *requestError) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(e.status)
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Code   string `json:"code"`
		Field  string `json:"field,omitempty"`
	}{"about:blank", http.StatusText(e.status), e.status, e.code, e.field})
}

func newSecretID() string {
	var id [16]byte
	rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func (a *writeAPI) transfer(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	result := "failure"
	var logBox, logOrg string
	var count int
	defer func() {
		slog.Info("secret transfer", "route", "/internal/v1/boxes/{box_id}/secrets", "box_id", logBox, "org_id", logOrg, "count", count, "result", result, "latency", time.Since(started))
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if r.ContentLength > maxTransferBody {
		writeProblem(w, &requestError{status: 413, code: "payload_too_large"})
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeProblem(w, &requestError{status: 415, code: "unsupported_media_type"})
		return
	}
	// A context deadline alone cannot interrupt a blocked HTTP body read.
	deadline, _ := ctx.Deadline()
	if err := http.NewResponseController(w).SetReadDeadline(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeProblem(w, transferError(ctx, err))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTransferBody))
	if !time.Now().Before(deadline) {
		clear(body)
		writeProblem(w, transferError(ctx, context.DeadlineExceeded))
		return
	}
	if err != nil {
		clear(body)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeProblem(w, &requestError{status: 413, code: "payload_too_large"})
			return
		}
		writeProblem(w, &requestError{status: 400, code: "malformed_json"})
		return
	}
	req, failure := decodeTransfer(body)
	clear(body)
	if failure != nil {
		writeProblem(w, failure)
		return
	}
	boxID := r.PathValue("box_id")
	if failure = validateTransfer(ctx, boxID, &req); failure != nil {
		writeProblem(w, failure)
		return
	}
	logBox, logOrg, count = boxID, req.OrgID, len(req.Secrets)
	secrets := make([]secretstore.Secret, len(req.Secrets))
	for i, s := range req.Secrets {
		id := newSecretID()
		identity := encryption.SecretContext{OrganizationID: req.OrgID, SecretID: id, Version: 1, Hosts: s.Hosts, Headers: s.Headers}
		envelope, err := a.cipher.Encrypt(ctx, identity, []byte(s.Value))
		if err != nil {
			writeProblem(w, transferError(ctx, err))
			return
		}
		secrets[i] = secretstore.Secret{Metadata: secretstore.Metadata{ID: id, Name: s.Name, NormalizedName: s.Normalized, Hosts: s.Hosts, Headers: s.Headers, Placeholder: s.Placeholder, CreatedBy: req.CreatedBy}, Envelope: envelope}
	}
	results, err := secretstore.InsertBoxSecrets(ctx, a.pool, req.OrgID, boxID, secrets, func(ctx context.Context, i int, stored secretstore.Secret) error {
		return a.checkRetry(ctx, i, req.Secrets[i], stored)
	})
	if err != nil {
		writeProblem(w, transferError(ctx, err))
		return
	}
	status := http.StatusOK
	entries := make([]struct {
		Name string `json:"name"`
		ID   string `json:"secret_id"`
	}, len(results))
	for i, item := range results {
		if item.Inserted {
			status = http.StatusCreated
		}
		entries[i].Name, entries[i].ID = req.Secrets[i].Name, item.ID
	}
	result = "success"
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Secrets any `json:"secrets"`
	}{entries})
}

func transferError(ctx context.Context, err error) *requestError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &requestError{status: 503, code: "request_timeout"}
	}
	var requestErr *requestError
	if errors.As(err, &requestErr) {
		return requestErr
	}
	if errors.Is(err, secretstore.ErrBoxOrgMismatch) {
		return &requestError{status: 409, code: "box_org_mismatch"}
	}
	if errors.Is(err, secretstore.ErrBoxSecretsExist) {
		return &requestError{status: 409, code: "box_secrets_exist"}
	}
	if errors.Is(err, encryption.ErrProviderUnavailable) || errors.Is(err, encryption.ErrUnknownKey) || errors.Is(err, encryption.ErrAuthentication) || errors.Is(err, encryption.ErrInvalidInput) {
		return &requestError{status: 503, code: "encryption_unavailable"}
	}
	return &requestError{status: 500, code: "internal_error"}
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func sameHosts(a, b []string) bool {
	normalize := func(input []string) []string {
		out := make([]string, len(input))
		for i, host := range input {
			out[i] = asciiLower(host)
		}
		slices.Sort(out)
		return slices.Compact(out)
	}
	return slices.Equal(normalize(a), normalize(b))
}

func sameHeaders(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	normalized := make(map[string]string, len(a))
	for name, value := range a {
		normalized[asciiLower(name)] = value
	}
	for name, value := range b {
		if v, ok := normalized[asciiLower(name)]; !ok || v != value {
			return false
		}
	}
	return true
}

func (a *writeAPI) checkRetry(ctx context.Context, index int, requested transferSecret, stored secretstore.Secret) error {
	conflict := &requestError{status: 409, code: "secret_conflict", field: fmt.Sprintf("secrets[%d]", index)}
	m := stored.Metadata
	if requested.Name != m.Name || requested.Placeholder != m.Placeholder || !sameHosts(requested.Hosts, m.Hosts) || !sameHeaders(requested.Headers, m.Headers) {
		return conflict
	}
	identity := encryption.SecretContext{OrganizationID: m.OrganizationID, SecretID: m.ID, Version: 1, Hosts: m.Hosts, Headers: m.Headers}
	plaintext, err := a.cipher.Decrypt(ctx, identity, stored.Envelope)
	if err != nil {
		return err
	}
	defer clear(plaintext)
	if subtle.ConstantTimeCompare(plaintext, []byte(requested.Value)) != 1 {
		return conflict
	}
	return nil
}

func (a *writeAPI) metadata(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	result := "failure"
	var logID string
	defer func() {
		slog.Info("secret metadata", "route", "/internal/v1/secrets/{secret_id}", "secret_id", logID, "result", result, "latency", time.Since(started))
	}()
	id := r.PathValue("secret_id")
	if !isUUID(id) {
		writeProblem(w, invalid("secret_id_invalid", "secret_id"))
		return
	}
	logID = id
	ctx, cancel := context.WithTimeout(r.Context(), metadataTimeout)
	defer cancel()
	m, err := secretstore.ReadMetadata(ctx, a.pool, id)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		writeProblem(w, &requestError{status: 503, code: "request_timeout"})
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeProblem(w, &requestError{status: 404, code: "secret_not_found"})
		return
	}
	if err != nil {
		writeProblem(w, &requestError{status: 500, code: "internal_error"})
		return
	}
	result = "success"
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		ID             string            `json:"secret_id"`
		OrganizationID string            `json:"org_id"`
		Scope          string            `json:"scope"`
		BoxID          *string           `json:"box_id"`
		Name           string            `json:"name"`
		Disabled       bool              `json:"disabled"`
		Hosts          []string          `json:"hosts"`
		Headers        map[string]string `json:"headers"`
		Placeholder    string            `json:"placeholder"`
		KeyID          string            `json:"key_id"`
		CreatedBy      string            `json:"created_by"`
		CreatedAt      time.Time         `json:"created_at"`
	}{m.ID, m.OrganizationID, m.Scope, m.BoxID, m.Name, m.DisabledAt != nil, m.Hosts, m.Headers, m.Placeholder, m.KeyID, m.CreatedBy, m.CreatedAt})
}
