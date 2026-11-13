package attest

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// GCPIITName is the gcp_iit attestor's mode name.
const GCPIITName = "gcp_iit"

// GCPIITHeader carries the VM's instance identity token (audience=<Secret Server
// URL>&format=full). Cloud Run consumes Authorization, so it is never read here.
const GCPIITHeader = "X-Boxlite-Runner-Identity"

// maxIssuedAtSkew tolerates clock drift between Google and this server.
const maxIssuedAtSkew = 60 * time.Second

// GCPIITConfig holds the values a gcp_iit token must match.
type GCPIITConfig struct {
	Audience       string // expected aud: the Secret Server URL
	Project        string // expected google.compute_engine.project_id
	ServiceAccount string // expected email: the runner VMs' service account
}

// GCPIIT verifies an instance identity token and maps the VM to a runner.
type GCPIIT struct {
	cfg       GCPIITConfig
	tokens    TokenVerifier
	instances map[string]RunnerID
	now       func() time.Time
}

// NewGCPIIT builds the attestor; it reads only the registry's gcp_iit section.
func NewGCPIIT(cfg GCPIITConfig, tokens TokenVerifier, reg Registry) (*GCPIIT, error) {
	if cfg.Audience == "" || cfg.Project == "" || cfg.ServiceAccount == "" {
		return nil, errors.New("attest: gcp_iit needs an audience, a project, and a runner service account")
	}
	return &GCPIIT{cfg: cfg, tokens: tokens, instances: reg[GCPIITName], now: time.Now}, nil
}

func (g *GCPIIT) Name() string   { return GCPIITName }
func (g *GCPIIT) Header() string { return GCPIITHeader }

// Verify checks the token, then every claim the table in the design lists,
// and returns the registered runner. Rejections never echo token content.
func (g *GCPIIT) Verify(ctx context.Context, h http.Header) (RunnerID, error) {
	payload, err := g.tokens.Verify(ctx, h.Get(GCPIITHeader), g.cfg.Audience)
	if err != nil {
		return "", err
	}
	if payload.Issuer != "https://accounts.google.com" && payload.Issuer != "accounts.google.com" {
		return "", invalid(GCPIITName, "unexpected issuer")
	}
	if time.Unix(payload.IssuedAt, 0).After(g.now().Add(maxIssuedAtSkew)) {
		return "", invalid(GCPIITName, "issued in the future")
	}
	if email, _ := payload.Claims["email"].(string); email != g.cfg.ServiceAccount {
		return "", invalid(GCPIITName, "token is not from the runner service account")
	}
	if verified, _ := payload.Claims["email_verified"].(bool); !verified {
		return "", invalid(GCPIITName, "service account email is not verified")
	}
	google, _ := payload.Claims["google"].(map[string]any)
	compute, ok := google["compute_engine"].(map[string]any)
	if !ok {
		return "", invalid(GCPIITName, "token has no Compute Engine claims")
	}
	if project, _ := compute["project_id"].(string); project != g.cfg.Project {
		return "", invalid(GCPIITName, "token is from another project")
	}
	instance, _ := compute["instance_id"].(string)
	runner, ok := g.instances[instance]
	if instance == "" || !ok {
		return "", invalid(GCPIITName, "instance is not registered")
	}
	return runner, nil
}
