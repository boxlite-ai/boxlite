package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

const outboundRecoveryGatePath = "/network/outbound/recovery-gate"

type recoveryGateID struct {
	Epoch      string `json:"epoch"`
	Generation string `json:"generation"`
}

func (id recoveryGateID) valid() bool {
	return validOutboundRevision(id.Epoch) && validOutboundRevision(id.Generation)
}

type recoveryGate struct {
	recoveryGateID
	Closed bool `json:"closed"`
	Sealed bool `json:"sealed"`
}

type recoveryGateRequest struct {
	recoveryGateID
	Action   string               `json:"action"`
	Revision string               `json:"revision"`
	Binding  *managedProxyBinding `json:"binding"`
}

func (p *outboundPolicyController) serveRecoveryGate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		w.Header().Set("Allow", "PUT")
		http.Error(w, "PUT required", http.StatusMethodNotAllowed)
		return
	}
	if !p.beginPut() {
		http.Error(w, "managed network stopped", http.StatusServiceUnavailable)
		return
	}
	defer p.puts.Done()

	controller := http.NewResponseController(w)
	if controller.SetReadDeadline(time.Now().Add(5*time.Second)) == nil {
		defer controller.SetReadDeadline(time.Time{})
	}
	var request recoveryGateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF ||
		!request.valid() || !validOutboundRevision(request.Revision) ||
		(request.Action != "release" && request.Action != "seal") {
		http.Error(w, "invalid recovery gate request", http.StatusBadRequest)
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if status := p.changeRecoveryGate(r.Context(), request); status != http.StatusNoContent {
		http.Error(w, "recovery gate change was not confirmed", status)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (p *outboundPolicyController) changeRecoveryGate(ctx context.Context, request recoveryGateRequest) int {
	if ctx.Err() != nil {
		return http.StatusServiceUnavailable
	}
	active := p.active.Load()
	if active.recoveryGate == nil || active.recoveryGate.recoveryGateID != request.recoveryGateID ||
		active.revision != request.Revision || !recoveryBindingMatches(active, request.Binding) {
		return http.StatusPreconditionFailed
	}

	next := *active
	gate := *active.recoveryGate
	next.recoveryGate = &gate
	if request.Action == "release" {
		if gate.Sealed || active.state != "confirmed" {
			return http.StatusConflict
		}
		if !gate.Closed {
			return http.StatusNoContent
		}
		gate.Closed = false
		if !next.ingressClosed() && next.proxyDNS == nil {
			next.udpRelay = p.newUDPRelay()
		}
		if !p.publish(&next, next.state) {
			if next.udpRelay != nil {
				next.udpRelay.seal()
			}
			return http.StatusServiceUnavailable
		}
		return http.StatusNoContent
	}

	gate.Closed = true
	gate.Sealed = true
	if !p.publish(&next, next.state) {
		return http.StatusServiceUnavailable
	}
	if next.udpRelay != nil {
		next.udpRelay.seal()
		drain, cancel := context.WithTimeout(ctx, udpCutoverTimeout)
		defer cancel()
		if next.udpRelay.generation.wait(drain) != nil {
			return http.StatusServiceUnavailable
		}
		next.udpRelay = nil
		if !p.publish(&next, next.state) {
			return http.StatusServiceUnavailable
		}
	}
	return http.StatusNoContent
}

func recoveryBindingMatches(snapshot *outboundSnapshot, expected *managedProxyBinding) bool {
	if snapshot.proxyDNS == nil {
		return expected == nil
	}
	actual := snapshot.proxyDNS.binding
	return expected != nil && actual != nil && *expected == *actual
}
