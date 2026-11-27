// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/boxlite-ai/common-go/pkg/featureusage"
)

func (p *Proxy) startFeatureUsage(ctx context.Context) {
	if p.apiclient == nil {
		return
	}
	config := p.apiclient.GetConfig()
	if len(config.Servers) == 0 {
		return
	}
	authorization := config.DefaultHeader["Authorization"]
	if !strings.HasPrefix(authorization, "Bearer ") {
		return
	}
	reporter, err := featureusage.NewReporter(config.Servers[0].URL, strings.TrimPrefix(authorization, "Bearer "), slog.Default())
	if err != nil {
		slog.Warn("Cloud feature usage reporting disabled", "error_type", "invalid_configuration")
		return
	}
	p.featureUsage = reporter
	go reporter.Run(ctx)
}

// Only the transport result is observed; no response body is read or delayed.
type featureUsageTransport struct {
	next     http.RoundTripper
	reporter *featureusage.Reporter
	boxID    string
}

func (t featureUsageTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.next.RoundTrip(request)
	if err == nil && response != nil {
		if response.StatusCode == http.StatusSwitchingProtocols {
			t.reporter.Record(featureusage.Event{BoxID: t.boxID, Kind: featureusage.TunnelConnection})
		} else if response.StatusCode >= 200 && response.StatusCode < 400 {
			t.reporter.Record(featureusage.Event{BoxID: t.boxID, Kind: featureusage.TunnelRequest})
		}
	}
	return response, err
}
