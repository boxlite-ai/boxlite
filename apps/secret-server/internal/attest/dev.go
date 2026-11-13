package attest

import (
	"context"
	"net/http"
)

// DevName is the dev attestor's mode name.
const DevName = "dev"

// DevHeader carries the runner ID directly. Local runs only.
const DevHeader = "X-Boxlite-Dev-Runner"

// Dev trusts the runner ID in DevHeader; New allows it only in local and dev.
type Dev struct {
	reg Registry
}

func (d *Dev) Name() string   { return DevName }
func (d *Dev) Header() string { return DevHeader }

// Verify refuses runners registered for another attestor, such as gcp_iit.
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
