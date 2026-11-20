/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/internal"
	"github.com/boxlite-ai/runner/internal/metrics"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

type HealthcheckServiceConfig struct {
	Interval   time.Duration
	Timeout    time.Duration
	Collector  *metrics.Collector
	Logger     *slog.Logger
	Domain     string
	ApiPort    int
	ProxyPort  int
	TlsEnabled bool
	Boxlite    *blclient.Client
	// Data disk identity from the infra-injected env keys (hyperdisk LLD §4.2).
	// Any part missing leaves the healthcheck without a dataDiskRef: only a
	// complete ref is useful to the API's disk-expansion controller.
	GCPProjectID       string
	GCPZone            string
	RunnerDataDiskName string
	// RunnerDataDiskType names the backend behind the identity (optional; the
	// API assumes hyperdisk_balanced when absent). Empty on hosts whose infra
	// predates the field.
	RunnerDataDiskType string
	// BoxliteHomeDir is the directory whose filesystem must carry the data
	// disk for the identity to be advertised; empty leaves nothing to verify
	// against, so the identity is never advertised.
	BoxliteHomeDir string
	// DataDiskDevicePath is the stable path of the host's data disk device.
	// Empty means the host has no data disk: the identity is then never
	// advertised even when the environment names one.
	DataDiskDevicePath string
	// VerifyDataDiskBacking replaces the platform default in tests. nil selects
	// the platform default, which off Linux never passes: verification is a
	// Linux-host concern and desktop builds stay out of the decision.
	VerifyDataDiskBacking func(homeDir, devicePath string) error
}

type Service struct {
	log        *slog.Logger
	interval   time.Duration
	timeout    time.Duration
	collector  *metrics.Collector
	client     *apiclient.APIClient
	domain     string
	apiPort    int
	proxyPort  int
	tlsEnabled bool
	boxlite    *blclient.Client
	// dataDiskRef is the cloud disk identity the environment assembles; nil
	// unless project, zone and disk name are all set, so a runner without the
	// infra-injected env never sends a partial identity. The healthcheck
	// advertises it only while the backing check passes (see
	// resolveDataDiskRef), so env presence alone never puts it on the wire.
	dataDiskRef *apiclient.RunnerDataDiskRef
	// Backing-gate inputs and hook, resolved once at construction.
	boxliteHomeDir        string
	dataDiskDevicePath    string
	verifyDataDiskBacking func(homeDir, devicePath string) error
	// backingSkipLogged keeps the not-advertised reason to one log per process:
	// for a legacy host this is the steady state, and a per-tick repeat would
	// only restate it.
	backingSkipLogged bool
}

func NewService(cfg *HealthcheckServiceConfig) (*Service, error) {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	if cfg.Boxlite == nil {
		return nil, fmt.Errorf("boxlite client is required for healthcheck service")
	}

	logger := slog.Default()
	if cfg.Logger != nil {
		logger = cfg.Logger
	}

	var dataDiskRef *apiclient.RunnerDataDiskRef
	if cfg.GCPProjectID != "" && cfg.GCPZone != "" && cfg.RunnerDataDiskName != "" {
		dataDiskRef = apiclient.NewRunnerDataDiskRef("gcp", cfg.GCPProjectID, cfg.GCPZone, cfg.RunnerDataDiskName)
		dataDiskRef.SetDiskType(cfg.RunnerDataDiskType)
	}

	verify := cfg.VerifyDataDiskBacking
	if verify == nil {
		verify = verifyDataDiskBacking
	}

	return &Service{
		log:                   logger.With(slog.String("component", "healthcheck")),
		client:                apiClient,
		interval:              cfg.Interval,
		timeout:               cfg.Timeout,
		collector:             cfg.Collector,
		domain:                cfg.Domain,
		apiPort:               cfg.ApiPort,
		proxyPort:             cfg.ProxyPort,
		tlsEnabled:            cfg.TlsEnabled,
		boxlite:               cfg.Boxlite,
		dataDiskRef:           dataDiskRef,
		boxliteHomeDir:        cfg.BoxliteHomeDir,
		dataDiskDevicePath:    cfg.DataDiskDevicePath,
		verifyDataDiskBacking: verify,
	}, nil
}

func (s *Service) Start(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	if err := s.sendHealthcheck(ctx); err != nil {
		s.log.WarnContext(ctx, "Failed to send initial healthcheck", "error", err)
	}

	for {
		select {
		case <-ctx.Done():
			s.log.InfoContext(ctx, "Healthcheck loop stopped")
			return
		case <-ticker.C:
			if err := s.sendHealthcheck(ctx); err != nil {
				s.log.WarnContext(ctx, "Failed to send healthcheck", "error", err)
			}
		}
	}
}

// resolveDataDiskRef re-derives the advertised identity on every healthcheck.
// The environment triple names a disk infra believes this host has; the
// backing check verifies the belief: the device node must exist and the
// filesystem holding the home directory must be carried by it. A host created
// before the data disk carries the converged environment but keeps box state
// on its root filesystem — advertising there would hand the control plane the
// identity of a disk that is not the one holding state, and its expansion
// controller would size a resize for the wrong device (a root-filesystem
// target against an unattached disk). Any check failure omits the ref, and a
// later attach+mount flips it back on without a runner restart.
func (s *Service) resolveDataDiskRef() *apiclient.RunnerDataDiskRef {
	if s.dataDiskRef == nil || s.dataDiskDevicePath == "" {
		return nil
	}
	if err := s.verifyDataDiskBacking(s.boxliteHomeDir, s.dataDiskDevicePath); err != nil {
		s.logOnceBackingSkip(err)
		return nil
	}
	return s.dataDiskRef
}

// logOnceBackingSkip emits the not-advertised reason once per process: a
// legacy host's steady state is a permanent skip, and a per-tick repeat would
// only restate the same fact.
func (s *Service) logOnceBackingSkip(reason error) {
	if s.backingSkipLogged {
		return
	}
	s.backingSkipLogged = true
	s.log.DebugContext(context.Background(), "Cloud data-disk identity not advertised: backing check failed",
		"error", reason.Error())
}

func (s *Service) newHealthcheck(nestedVirtualizationEnabled bool) *apiclient.RunnerHealthcheck {
	healthcheck := apiclient.NewRunnerHealthcheck(internal.Version)
	healthcheck.SetDomain(s.domain)
	healthcheck.SetSupportsPrivileged(true)
	healthcheck.SetNestedVirtualizationEnabled(nestedVirtualizationEnabled)

	proxyUrl := fmt.Sprintf("http://%s:%d", s.domain, s.proxyPort)
	apiUrl := fmt.Sprintf("http://%s:%d", s.domain, s.apiPort)

	if s.tlsEnabled {
		apiUrl = fmt.Sprintf("https://%s:%d", s.domain, s.apiPort)
		proxyUrl = fmt.Sprintf("https://%s:%d", s.domain, s.proxyPort)
	}

	healthcheck.SetProxyUrl(proxyUrl)
	healthcheck.SetApiUrl(apiUrl)

	// The advertised disk identity is re-derived per healthcheck, not fixed at
	// construction: a disk attached and mounted mid-run advertises on the next
	// tick without a restart, and a device that disappears stops advertising.
	if ref := s.resolveDataDiskRef(); ref != nil {
		healthcheck.SetDataDiskRef(*ref)
	}

	return healthcheck
}

func (s *Service) sendHealthcheck(ctx context.Context) error {
	reqCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	healthcheck := s.newHealthcheck(s.boxlite.NestedVirtualizationEnabled())

	runtimeHealth := apiclient.RunnerServiceHealth{
		ServiceName: "boxlite",
		Healthy:     true,
	}

	err := s.boxlite.Ping(reqCtx)
	if err != nil {
		s.log.WarnContext(reqCtx, "Failed to ping BoxLite runtime", "error", err)

		errStr := err.Error()
		runtimeHealth.Healthy = false
		runtimeHealth.ErrorReason = &errStr
	}

	healthcheck.SetServiceHealth([]apiclient.RunnerServiceHealth{runtimeHealth})

	m, err := s.collector.Collect(reqCtx)
	if err != nil {
		s.log.WarnContext(reqCtx, "Failed to collect metrics for healthcheck", "error", err)
	} else {
		healthcheck.SetMetrics(apiclient.RunnerHealthMetrics{
			CurrentCpuLoadAverage:        m.CPULoadAverage,
			CurrentCpuUsagePercentage:    m.CPUUsagePercentage,
			CurrentMemoryUsagePercentage: m.MemoryUsagePercentage,
			CurrentDiskUsagePercentage:   m.DiskUsagePercentage,
			CurrentAllocatedCpu:          m.AllocatedCPU,
			CurrentAllocatedMemoryGiB:    m.AllocatedMemoryGiB,
			CurrentAllocatedDiskGiB:      m.AllocatedDiskGiB,
			CurrentStartedBoxes:          m.StartedBoxCount,
			Cpu:                          m.TotalCPU,
			MemoryGiB:                    m.TotalRAMGiB,
			DiskGiB:                      m.TotalDiskGiB,
		})
	}

	req := s.client.RunnersAPI.RunnerHealthcheck(reqCtx).RunnerHealthcheck(*healthcheck)
	_, err = req.Execute()
	if err != nil {
		return err
	}

	s.log.DebugContext(reqCtx, "Healthcheck sent successfully")
	return nil
}
