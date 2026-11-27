package main

import (
	"encoding/json"
	"io"
	"net/http"
	"time"
)

const ipv6ReadinessPath = "/network/ipv6-ready"
const ipv6ReadinessWindow = 15 * time.Second

type ipv6Readiness struct {
	Plan     ipv6LinkPlan `json:"plan"`
	Revision string       `json:"revision"`
	Epoch    string       `json:"epoch"`
}

// The control mux is available only on the host-side Unix socket.
func (p *outboundPolicyController) serveIPv6Readiness(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current := p.active.Load()
	plan := current.completeSnapshot().IPv6
	if plan == nil || current.state != "confirmed" || !p.guard.supportsIPv6() {
		http.Error(w, "guest IPv6 link is unavailable", http.StatusConflict)
		return
	}
	switch r.Method {
	case http.MethodGet:
		epoch, err := newOutboundRevision()
		if err != nil {
			http.Error(w, "create IPv6 readiness epoch", http.StatusInternalServerError)
			return
		}
		p.ipv6ReadinessRevision = ""
		p.ipv6Challenge = ipv6Readiness{Plan: *plan, Revision: current.revision, Epoch: epoch}
		p.ipv6ReadinessUntil = time.Now().Add(ipv6ReadinessWindow)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(p.ipv6Challenge)
	case http.MethodPost:
		var proof ipv6Readiness
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
		if err != nil || decodeOutboundJSON(body, &proof) != nil {
			http.Error(w, "invalid Guest IPv6 readiness", http.StatusBadRequest)
			return
		}
		expected := p.ipv6Challenge
		if expected.Epoch == "" || proof != expected || proof.Revision != current.revision || proof.Plan != *plan ||
			!time.Now().Before(p.ipv6ReadinessUntil) {
			http.Error(w, "Guest IPv6 readiness does not match this link", http.StatusConflict)
			return
		}
		p.ipv6Challenge = ipv6Readiness{}
		p.ipv6LinkConfirmed.Store(true)
		if current.policy.Mode == "enabled" {
			p.ipv6Ready.Store(true)
		} else {
			p.ipv6ReadinessRevision = current.revision
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
