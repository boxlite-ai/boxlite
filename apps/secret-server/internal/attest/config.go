package attest

import (
	"errors"
	"fmt"
	"log/slog"
)

// knownAttestors lists every mode name configuration and the registry accept.
var knownAttestors = map[string]struct{}{GCPIITName: {}, DevName: {}}

// Config is the attestation part of the Secret Server configuration.
type Config struct {
	Attestors   []string // SECRET_SERVER_ATTESTORS, such as ["gcp_iit"]
	Environment string   // ENVIRONMENT: local, dev, staging, or production
	GCPIIT      GCPIITConfig
	Registry    string // SECRET_SERVER_RUNNER_REGISTRY JSON
}

// New validates cfg and builds the Selector the fetch route calls. tokens is
// used only when gcp_iit is enabled. Every error here should fail startup.
func New(cfg Config, tokens TokenVerifier, logger *slog.Logger) (*Selector, error) {
	if len(cfg.Attestors) == 0 {
		return nil, errors.New("attest: SECRET_SERVER_ATTESTORS lists no attestor")
	}
	reg, err := ParseRegistry(cfg.Registry)
	if err != nil {
		return nil, err
	}
	enabled := make(map[string]bool, len(cfg.Attestors))
	var attestors []Attestor
	for _, name := range cfg.Attestors {
		if enabled[name] {
			return nil, fmt.Errorf("attest: attestor %q is listed twice", name)
		}
		enabled[name] = true
		switch name {
		case GCPIITName:
			if tokens == nil {
				return nil, errors.New("attest: gcp_iit needs a token verifier")
			}
			gcp, err := NewGCPIIT(cfg.GCPIIT, tokens, reg)
			if err != nil {
				return nil, err
			}
			attestors = append(attestors, gcp)
		case DevName:
			if cfg.Environment != "local" && cfg.Environment != "dev" {
				return nil, fmt.Errorf("attest: the dev attestor is refused when ENVIRONMENT is %q", cfg.Environment)
			}
			attestors = append(attestors, &Dev{reg: reg})
		default:
			return nil, fmt.Errorf("attest: unknown attestor %q", name)
		}
	}
	if enabled[GCPIITName] && len(reg[GCPIITName]) == 0 {
		logger.Warn("runner registry has no gcp_iit instances; every gcp_iit proof will be rejected")
	}
	for mode := range reg {
		if !enabled[mode] {
			logger.Warn("runner registry has entries for a disabled attestor", "mode", mode)
		}
	}
	return NewSelector(attestors...), nil
}
