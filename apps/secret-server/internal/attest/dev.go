package attest

import (
	"context"
	"net/http"
)

// DevName is the dev attestor's mode name.
const DevName = "dev"

// DevHeader carries the runner ID directly. Local runs only.
const DevHeader = "X-Boxlite-Dev-Runner"

// Dev trusts the runner ID in DevHeader. New refuses it outside local and dev
// environments.
type Dev struct {
	reg Registry
}

func (d *Dev) Name() string   { return DevName }
func (d *Dev) Header() string { return DevHeader }

// Verify still refuses a runner registered under another mode, so a dev
// header cannot impersonate a runner registered for gcp_iit.
func (d *Dev) Verify(_ context.Context, h http.Header) (RunnerID, error) {
	runner := RunnerID(h.Get(DevHeader))
	if runner == "" {
		return "", invalid(DevName, "empty runner ID")
	}
	if d.reg.registeredElsewhere(DevName, runner) {
		return "", invalid(DevName, "runner is registered for another attestor")
	}
	return runner, nil
}
