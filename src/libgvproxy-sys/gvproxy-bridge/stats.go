package main

import (
	"net/http/httptest"

	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
)

// collectNetworkStats extracts statistics from VirtualNetwork instance.
//
// Design:
// - Uses formal HTTP endpoint: Invokes VirtualNetwork's /stats handler directly
// - No reflection on unexported fields: Uses official API surface
// - Future-proof: Will get all new stats automatically from upstream
//
// Why this approach:
// - VirtualNetwork exposes ServicesMux() with /stats endpoint
// - We invoke the handler directly without starting HTTP server (httptest)
// - Same code path as HTTP clients, guaranteed to work
//
// Naming alternatives considered:
// - getStats, fetchStats, extractStats, readStats, collectStats ✅
func collectNetworkStats(vn *virtualnetwork.VirtualNetwork) string {
	if vn == nil {
		return ""
	}

	// Get the HTTP mux with /stats endpoint
	mux := vn.ServicesMux()

	// Create fake HTTP request/response (no actual network involved)
	req := httptest.NewRequest("GET", "/stats", nil)
	rec := httptest.NewRecorder()

	// Invoke the /stats handler directly
	mux.ServeHTTP(rec, req)

	// Return the JSON response body
	return rec.Body.String()
}
