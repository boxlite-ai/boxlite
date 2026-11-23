package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

type grant struct {
	SecretID string `json:"secret_id"`
}
type authorization struct {
	Active         bool      `json:"active"`
	CredentialID   string    `json:"credential_id"`
	RunnerID       string    `json:"runner_id"`
	BoxID          string    `json:"box_id"`
	OrganizationID string    `json:"organization_id"`
	Grants         []grant   `json:"grants"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type apiClient struct {
	endpoint string
	http     http.Client
}

func newClient(endpoint string) (*apiClient, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid introspection endpoint")
	}
	if ip, _ := netip.ParseAddr(u.Hostname()); u.Scheme == "http" && !ip.IsLoopback() {
		return nil, errors.New("introspection requires HTTPS outside literal loopback")
	}
	return &apiClient{endpoint: endpoint, http: http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *apiClient) consume(ctx context.Context, token, runner string) (authorization, error) {
	var a authorization
	body, _ := json.Marshal(map[string]string{"token": token, "runner_id": runner})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return a, err
	}
	// POST has no idempotency key; Go's transport must not replay consumption.
	req.GetBody = nil
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return a, errors.New("introspection transport failed")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil || len(data) > 65536 || resp.StatusCode != 200 {
		return a, errors.New("introspection response failed")
	}
	var active struct {
		Active *bool `json:"active"`
	}
	if json.Unmarshal(data, &active) != nil || active.Active == nil || json.Unmarshal(data, &a) != nil {
		return authorization{}, errors.New("invalid introspection response")
	}
	if !a.Active {
		return authorization{}, nil
	}
	if !uuid(a.CredentialID) || !uuid(a.OrganizationID) || a.RunnerID == "" || len(a.RunnerID) > 256 || a.BoxID == "" || len(a.BoxID) > 64 || !a.ExpiresAt.After(time.Now()) || a.Grants == nil || len(a.Grants) > 64 {
		return authorization{}, errors.New("incomplete authorization")
	}
	seen := make(map[string]bool, len(a.Grants))
	for i, g := range a.Grants {
		id := strings.ToLower(g.SecretID)
		if !uuid(id) || seen[id] {
			return authorization{}, errors.New("invalid grant")
		}
		seen[id] = true
		a.Grants[i].SecretID = id
	}
	a.OrganizationID = strings.ToLower(a.OrganizationID)
	return a, nil
}

func uuid(s string) bool {
	var id pgtype.UUID
	return len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-' && id.Scan(s) == nil && id.Valid
}
