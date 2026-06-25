// installTCPOverride wraps the OverrideTCPHandler call site so tests
// can inject failure without standing up a real VirtualNetwork.
//
// `hasTCPFilter` mirrors the production guard: skip the install when
// neither `allow_net` nor MITM secrets are configured.
//
// `installFn` is a thin closure that, in production, calls
// OverrideTCPHandler with the live vn / tapConfig / TCPFilter / CA /
// secretMatcher. Tests pass a stub that returns the failure shape
// they want to validate.
//
// Returns the underlying error verbatim — the caller (init goroutine
// in main.go) wraps it via `sink.Init("OverrideTCPHandler", err)` so
// the box.create call surfaces it via the cgo `errOut` string.
//
// Why this exists: pre-#634 the `OverrideTCPHandler` call lived inline
// and ignored its return value entirely (`logrus.Error` + continue).
// That made the box.create call succeed even when allow_net/MITM
// silently failed — a security-shaped silent failure. The new wiring
// (init phase + sink.Init + this extracted helper) gives the failure
// three independent observation points:
//   1. operator-visible error from box.create
//   2. test-time toggle via this helper (see install_tcp_override_test.go)
//   3. code review can audit the single call site

package main

func installTCPOverride(hasTCPFilter bool, installFn func() error) error {
	if !hasTCPFilter {
		return nil
	}
	return installFn()
}

// newTCPFilterFromConfig is the inline TCPFilter construction extracted
// from main.go, kept as a top-level helper so it stays in one place
// (the install helper above no longer needs the config fields directly).
//
// Returns nil when allow_net is empty — the caller (OverrideTCPHandler)
// then runs in MITM-only mode (secretMatcher non-nil but no allow_net
// filter on top).
func newTCPFilterFromConfig(config GvproxyConfig) *TCPFilter {
	if len(config.AllowNet) == 0 {
		return nil
	}
	return NewTCPFilter(config.AllowNet, config.GatewayIP, config.GuestIP, config.HostIP)
}
