// Package health implements the HTTP readiness probe used to gate a new release
// (contracts.md section 0: "2xx within 60 s = healthy").
package health

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// Defaults from the contract.
const (
	DefaultBudget   = 60 * time.Second
	DefaultInterval = 500 * time.Millisecond
	requestTimeout  = 2 * time.Second
)

// Result summarises one probe loop.
type Result struct {
	Healthy  bool
	Status   int           // last HTTP status seen (0 if none)
	Attempts int           // requests made
	Elapsed  time.Duration // time until success or budget exhaustion
	LastErr  string        // last transport error, if any
}

// String renders the result for a system log line.
func (r Result) String() string {
	if r.Healthy {
		return fmt.Sprintf("healthy after %s (HTTP %d, %d attempt(s))", r.Elapsed.Round(time.Millisecond), r.Status, r.Attempts)
	}
	detail := r.LastErr
	if detail == "" && r.Status != 0 {
		detail = fmt.Sprintf("HTTP %d", r.Status)
	}
	if detail == "" {
		detail = "no response"
	}
	return fmt.Sprintf("unhealthy after %s (%d attempt(s), last: %s)", r.Elapsed.Round(time.Millisecond), r.Attempts, detail)
}

// Probe GETs url every interval until a 2xx arrives, the budget runs out or ctx
// is cancelled (for example because the probed process exited).
func Probe(ctx context.Context, url string, budget, interval time.Duration) Result {
	if budget <= 0 {
		budget = DefaultBudget
	}
	if interval <= 0 {
		interval = DefaultInterval
	}
	client := &http.Client{Timeout: requestTimeout}
	start := time.Now()
	deadline := start.Add(budget)
	var res Result
	for {
		res.Attempts++
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			res.LastErr = err.Error()
			res.Elapsed = time.Since(start)
			return res
		}
		req.Header.Set("User-Agent", "boxlite-supervisor-health")
		resp, err := client.Do(req)
		if err != nil {
			res.LastErr = err.Error()
		} else {
			resp.Body.Close()
			res.Status = resp.StatusCode
			res.LastErr = ""
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				res.Healthy = true
				res.Elapsed = time.Since(start)
				return res
			}
		}
		now := time.Now()
		if ctx.Err() != nil || !now.Add(interval).Before(deadline) {
			res.Elapsed = time.Since(start)
			if ctx.Err() != nil && res.LastErr == "" {
				res.LastErr = ctx.Err().Error()
			}
			return res
		}
		select {
		case <-ctx.Done():
			res.Elapsed = time.Since(start)
			return res
		case <-time.After(interval):
		}
	}
}
