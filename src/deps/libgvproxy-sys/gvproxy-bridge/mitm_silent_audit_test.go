package main

import (
	"errors"
	"strings"
	"testing"
)

// Audit of all `logrus.Error|Warn|Debug + return` sites in mitm.go /
// mitm_proxy.go / mitm_websocket.go and the classification chosen:
//
//   site                                  level   wire to ErrSink?  rationale
//   ───────────────────────────────────────────────────────────────────────────
//   mitm_proxy.go:22  cert generation     ERROR   YES (this PR)     security-shaped: persistent failure = MITM
//                                                                   silently disabled for hostname; operator must see
//   mitm_proxy.go:66  TLS handshake       DEBUG   NO                per-conn expected (client gives up early, retries, etc.)
//   mitm_websocket.go:52 upstream dial    WARN    NO                per-conn dial failure; legit WARN, not silent regression
//   mitm_websocket.go:63 request write    WARN    NO                per-conn; same
//   mitm_websocket.go:73 response read    WARN    NO                per-conn; same
//   mitm_websocket.go:91 hijack failed    WARN    NO                per-conn; same
//
// The tests below pin the wiring choice for the YES row and document
// the rationale for the NO rows.

// TestBoxCA_ReportCertGenFailure_NoSink_IsNoop pins that the helper is
// safe to call before SetErrSink — pre-init paths, tests that don't
// care about the sink, etc. Without this, every BoxCA construction
// would crash if the sink wasn't set.
func TestBoxCA_ReportCertGenFailure_NoSink_IsNoop(t *testing.T) {
	ca := &BoxCA{} // no sink set
	// Must not panic.
	ca.reportCertGenFailure("example.com", errors.New("crypto/rsa: key too short"))
}

// TestBoxCA_ReportCertGenFailure_WithSink_RoutesToRuntime pins the
// production wiring contract: the cert-gen failure DOES land on the
// sink with source="mitm.GenerateHostCert" and a cause string that
// names the failing hostname.
//
// Two-sided contract: remove `ca.errSink.Runtime(...)` from
// reportCertGenFailure and this test reds with "expected
// mitm.GenerateHostCert runtime error in sink, got nil — pre-fix
// silent: MITM cert gen failed, only logrus saw it".
func TestBoxCA_ReportCertGenFailure_WithSink_RoutesToRuntime(t *testing.T) {
	sink := NewErrSink(300)
	ca := &BoxCA{}
	ca.SetErrSink(sink)

	cause := errors.New("crypto: invalid algorithm parameters")
	ca.reportCertGenFailure("api.example.com", cause)

	re := sink.PollRuntime()
	if re == nil {
		t.Fatal(
			"expected mitm.GenerateHostCert runtime error in sink, got nil — " +
				"pre-fix silent: MITM cert gen failed, only logrus saw it. " +
				"The Rust runtime + box log file never observed the failure",
		)
	}
	if re.Source != "mitm.GenerateHostCert" {
		t.Errorf("source = %q, want %q", re.Source, "mitm.GenerateHostCert")
	}
	// Hostname must appear in the cause string — operators chasing a
	// silent MITM failure need to know WHICH host couldn't be intercepted.
	if !strings.Contains(re.Err.Error(), "api.example.com") {
		t.Errorf(
			"cause must name the failing hostname for operator debugging; "+
				"got: %v",
			re.Err,
		)
	}
	// Underlying cause must be wrapped (not stringified).
	if !errors.Is(re.Err, cause) {
		t.Errorf("cause must wrap the original error; got: %v", re.Err)
	}
}

// TestBoxCA_SetErrSink_NilIsHonored pins that passing nil to
// SetErrSink reverts to the no-op behavior — useful for tests and
// pre-init paths that want to disable the sink after construction.
func TestBoxCA_SetErrSink_NilIsHonored(t *testing.T) {
	ca := &BoxCA{}
	sink := NewErrSink(301)
	ca.SetErrSink(sink)
	ca.SetErrSink(nil) // explicit disable

	// Must not panic + must not push to the original sink.
	ca.reportCertGenFailure("example.com", errors.New("test"))
	if re := sink.PollRuntime(); re != nil {
		t.Errorf("sink should be empty after SetErrSink(nil); got %s", re)
	}
}
