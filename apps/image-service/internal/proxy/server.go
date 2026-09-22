// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/image-service/cmd/registry-proxy/config"
	"github.com/boxlite-ai/image-service/internal"
	"github.com/boxlite-ai/image-service/internal/oci"
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"
)

// ServiceName names this process to the telemetry pipeline and to the traces
// it emits.
const ServiceName = "boxlite-registry-proxy"

// HealthPath is what the platform probes to decide the process is up. It is
// deliberately outside /v2/, which belongs to the distribution protocol.
const HealthPath = "/health"

// readHeaderTimeout bounds how long a connection may hold the server without
// stating what it wants. The response has no such bound here: a blob is
// arbitrarily large, so how long it may take is left to the caller and, when
// deployed, to the platform's request timeout.
const readHeaderTimeout = 10 * time.Second

// Start runs the registry proxy until ctx is cancelled, then drains in-flight
// pulls within the configured shutdown timeout.
func Start(ctx context.Context, cfg *config.Config, api *apiclient.APIClient) error {
	address := fmt.Sprintf(":%d", cfg.Port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	slog.Info("Registry proxy is running", "port", cfg.Port, "version", internal.Version)

	return serve(ctx, listener, NewRouter(cfg, api), time.Duration(cfg.ShutdownTimeoutSec)*time.Second)
}

// serve answers on listener until ctx is cancelled, then stops accepting and
// gives the pulls already in flight up to drainTimeout to finish.
//
// Draining rather than closing is the whole point: a blob is one long response,
// so cutting the listener at shutdown truncates an image mid-layer and the
// puller sees a corrupt digest rather than a retryable failure.
func serve(ctx context.Context, listener net.Listener, handler http.Handler, drainTimeout time.Duration) error {
	server := &http.Server{Handler: handler, ReadHeaderTimeout: readHeaderTimeout}

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		slog.Info("Draining in-flight pulls", "timeout", drainTimeout)
		drainCtx, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		return server.Shutdown(drainCtx)
	}
}

// NewRouter builds the registry proxy's HTTP surface. It is separate from Start
// so the surface can be exercised without binding a port.
func NewRouter(cfg *config.Config, api *apiclient.APIClient) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)

	router := gin.New()
	router.Use(gin.Recovery())
	if cfg.OtelTracingEnabled && cfg.OtelEndpoint != "" {
		router.Use(otelgin.Middleware(ServiceName))
	}

	router.GET(HealthPath, func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": internal.Version})
	})

	// One client for pulls, redirects and token exchanges alike: they share the
	// address rule and the connection pool, and a token endpoint is as much an
	// upstream as the registry that named it.
	upstream := oci.NewClient(newUpstreamClient(routable, cfg.UpstreamTimeout))
	proxy := &registryProxy{
		upstream:  upstream,
		runners:   newRunnerAuthenticator(api, cfg.CredentialTTL, cfg.RejectionTTL),
		allowlist: newUpstreamAllowlist(cfg.UpstreamHosts),
		limits:    newPullLimiter(cfg.PullsPerSecond, cfg.PullBurst, cfg.TrackedMeters),
		tokens:    newTokenBroker(upstream),
	}
	// GET and HEAD share one handler: the distribution protocol answers both on
	// the manifest endpoint, and a HEAD is a GET whose body nobody reads.
	router.GET(oci.PathPrefix+"*path", proxy.handle)
	router.HEAD(oci.PathPrefix+"*path", proxy.handle)
	return router
}
