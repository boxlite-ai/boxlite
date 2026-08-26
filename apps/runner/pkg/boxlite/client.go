// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BoxLite AI (originally Daytona Platforms Inc.
// Modified and rebranded for BoxLite

// Package boxlite provides a BoxLite-backed implementation of the box runtime,
// replacing Docker with VM-based isolation via the BoxLite Go SDK.
package boxlite

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"go.opentelemetry.io/otel/propagation"
)

// Client wraps the BoxLite Go SDK to provide the same interface as the Docker client.
// It manages VMs instead of containers, providing hardware-level isolation.
type Client struct {
	runtime            *boxlite.Runtime
	logger             *slog.Logger
	homeDir            string
	mu                 sync.RWMutex
	boxes              map[string]*boxlite.Box
	awsRegion          string
	awsEndpointUrl     string
	awsAccessKeyId     string
	awsSecretAccessKey string
	volumeMutexes      map[string]*sync.Mutex
	volumeMutexesMutex sync.Mutex
	volumeCleanupMutex sync.Mutex
	lastVolumeCleanup  time.Time
	volumeCleanup      volumeCleanupConfig
}

// ClientConfig holds configuration for the BoxLite client.
type ClientConfig struct {
	Logger                       *slog.Logger
	HomeDir                      string
	InsecureRegistries           []string
	GhcrUsername                 string
	GhcrToken                    string
	DockerHubUsername            string
	DockerHubToken               string
	AWSRegion                    string
	AWSEndpointUrl               string
	AWSAccessKeyId               string
	AWSSecretAccessKey           string
	VolumeCleanupInterval        time.Duration
	VolumeCleanupDryRun          bool
	VolumeCleanupExclusionPeriod time.Duration
}

func networkSpec(blockAll *bool, allowList *string) boxlite.NetworkSpec {
	if blockAll != nil && *blockAll {
		return boxlite.NetworkSpec{Mode: boxlite.NetworkModeDisabled}
	}

	spec := boxlite.NetworkSpec{Mode: boxlite.NetworkModeEnabled}
	if allowList == nil {
		return spec
	}

	for _, entry := range strings.Split(*allowList, ",") {
		entry = strings.TrimSpace(entry)
		if entry != "" {
			spec.AllowNet = append(spec.AllowNet, entry)
		}
	}
	return spec
}

func boxRuntimeEnv(ctx context.Context, boxDto dto.CreateBoxDTO) map[string]string {
	env := map[string]string{
		"BOXLITE_BOX_ID": boxDto.Id,
	}
	if boxDto.OtelEndpoint != nil && *boxDto.OtelEndpoint != "" {
		env["BOXLITE_OTEL_ENDPOINT"] = *boxDto.OtelEndpoint
	}
	if boxDto.OrganizationId != nil && *boxDto.OrganizationId != "" {
		env["BOXLITE_ORGANIZATION_ID"] = *boxDto.OrganizationId
	}
	if boxDto.RegionId != nil && *boxDto.RegionId != "" {
		env["BOXLITE_REGION_ID"] = *boxDto.RegionId
	}
	// Propagate the active W3C trace context into the box so in-box processes can
	// join the SAME traceId as the api->runner spans, instead of rooting a fresh
	// disjoint trace. With no active span the carrier is empty.
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	if traceParent := carrier.Get("traceparent"); traceParent != "" {
		env["BOXLITE_TRACEPARENT"] = traceParent
		if traceState := carrier.Get("tracestate"); traceState != "" {
			env["BOXLITE_TRACESTATE"] = traceState
		}
	}
	return env
}

// secretSpecs maps control-plane SecretDTOs onto the boxlite SDK's Secret
// values. Extracted as a pure function so the mapping is unit-testable without
// a live runtime (see secret_options_test.go). The SDK applies the
// `<BOXLITE_SECRET:{name}>` placeholder default when Placeholder is empty, so an
// omitted placeholder is passed through as-is rather than synthesized here.
func secretSpecs(secrets []dto.SecretDTO) []boxlite.Secret {
	specs := make([]boxlite.Secret, 0, len(secrets))
	for _, secret := range secrets {
		specs = append(specs, boxlite.Secret{
			Name:        secret.Name,
			Value:       secret.Value,
			Hosts:       secret.Hosts,
			Placeholder: secret.Placeholder,
		})
	}
	return specs
}

// buildImageRegistries assembles the runtime-scoped OCI registry list handed to boxlite-core:
// the existing insecure (HTTP, no-auth) registries, plus — when ghcr credentials are provided —
// a single authenticated ghcr.io HTTPS entry so core can pull private images
// directly from ghcr (no self-hosted registry mirror required). Auth is runtime-scoped because
// boxlite.Runtime.Create has no per-call credential parameter. When ghcrUsername/ghcrToken are
// empty this is byte-for-byte the previous behavior (anonymous), so it is safe to ship dark.
// Kept as a pure function so the wiring can be unit-tested without constructing a real runtime.
func buildImageRegistries(insecureRegistries []string, ghcrUsername, ghcrToken string) []boxlite.ImageRegistry {
	registries := make([]boxlite.ImageRegistry, 0, len(insecureRegistries)+1)
	for _, host := range insecureRegistries {
		registries = append(registries, boxlite.ImageRegistry{
			Host:       host,
			Transport:  boxlite.RegistryTransportHTTP,
			SkipVerify: true,
		})
	}
	if ghcrUsername != "" && ghcrToken != "" {
		registries = append(registries, boxlite.ImageRegistry{
			Host:      "ghcr.io",
			Transport: boxlite.RegistryTransportHTTPS,
			Auth: boxlite.ImageRegistryAuth{
				Username: ghcrUsername,
				Password: ghcrToken,
			},
		})
	}
	return registries
}

// NewClient creates a new BoxLite client backed by the BoxLite VM runtime.
func NewClient(ctx context.Context, config ClientConfig) (*Client, error) {
	var opts []boxlite.RuntimeOption
	if config.HomeDir != "" {
		opts = append(opts, boxlite.WithHomeDir(config.HomeDir))
	}
	insecureRegistries := normalizeRegistryHosts(config.InsecureRegistries)
	registries := buildImageRegistries(insecureRegistries, config.GhcrUsername, config.GhcrToken)
	// docker.io auth (local dev): boxlite-core pulls box base images (e.g. the
	// debian base disk + public user images) from docker.io; without auth those
	// hit the anonymous Docker Hub rate limit. Mirror the ghcr.io auth entry.
	if config.DockerHubUsername != "" && config.DockerHubToken != "" {
		registries = append(registries, boxlite.ImageRegistry{
			Host:      "docker.io",
			Transport: boxlite.RegistryTransportHTTPS,
			Auth: boxlite.ImageRegistryAuth{
				Username: config.DockerHubUsername,
				Password: config.DockerHubToken,
			},
		})
	}
	if len(registries) > 0 {
		opts = append(opts, boxlite.WithImageRegistries(registries...))
	}

	rt, err := boxlite.NewRuntime(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create boxlite runtime: %w", err)
	}

	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}

	return &Client{
		runtime:            rt,
		logger:             logger,
		homeDir:            config.HomeDir,
		boxes:              make(map[string]*boxlite.Box),
		awsRegion:          config.AWSRegion,
		awsEndpointUrl:     config.AWSEndpointUrl,
		awsAccessKeyId:     config.AWSAccessKeyId,
		awsSecretAccessKey: config.AWSSecretAccessKey,
		volumeMutexes:      make(map[string]*sync.Mutex),
		volumeCleanup: volumeCleanupConfig{
			interval:        config.VolumeCleanupInterval,
			dryRun:          config.VolumeCleanupDryRun,
			exclusionPeriod: config.VolumeCleanupExclusionPeriod,
		},
	}, nil
}

// Shutdown gracefully stops all running boxes in the underlying BoxLite
// runtime. Blocks until shutdown completes or `timeout` elapses. Call this
// BEFORE Close so VMs aren't killed mid-write on systemd SIGTERM.
//
// Without this, restart attempts for the killed boxes hit a 30s
// `guest_connect` timeout because the guest agent inside never re-establishes
// vsock after an unclean shutdown — and (until the matching Rust-side fix
// landed) that timeout would auto-delete the box record.
//
// `timeout=0` means "use the runtime default (10s)". Negative values are
// clamped by the SDK.
func (c *Client) Shutdown(ctx context.Context, timeout time.Duration) error {
	return c.runtime.Shutdown(ctx, timeout)
}

// Close releases the BoxLite runtime handle. Prefer calling `Shutdown` first
// so boxes get a graceful stop before the C handle is freed.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	for id, bx := range c.boxes {
		bx.Close()
		delete(c.boxes, id)
	}
	return c.runtime.Close()
}

// Create creates a new box (VM) from the given image and configuration.
// Returns the box ID and runtime version.
func (c *Client) Create(ctx context.Context, boxDto dto.CreateBoxDTO) (string, string, error) {
	// API sends cores / GB / GB as small integers (see apps/api Box entity).
	cpus := int(boxDto.CpuQuota)
	if cpus < 1 {
		cpus = 1
	}
	memoryMiB := int(boxDto.MemoryQuota * 1024)
	if memoryMiB < 128 {
		memoryMiB = 128
	}
	opts := []boxlite.BoxOption{
		boxlite.WithName(boxDto.Id),
		boxlite.WithCPUs(cpus),
		boxlite.WithMemory(memoryMiB),
		boxlite.WithAutoRemove(false),
		boxlite.WithDetach(true),
	}
	if boxDto.StorageQuota > 0 {
		opts = append(opts, boxlite.WithDiskSize(int(boxDto.StorageQuota)))
	}

	for k, v := range boxDto.Env {
		opts = append(opts, boxlite.WithEnv(k, v))
	}
	for k, v := range boxRuntimeEnv(ctx, boxDto) {
		opts = append(opts, boxlite.WithEnv(k, v))
	}
	for _, secret := range secretSpecs(boxDto.Secrets) {
		opts = append(opts, boxlite.WithSecret(secret))
	}

	if len(boxDto.Entrypoint) > 0 {
		opts = append(opts, boxlite.WithEntrypoint(boxDto.Entrypoint...))
	}

	if len(boxDto.Cmd) > 0 {
		opts = append(opts, boxlite.WithCmd(boxDto.Cmd...))
	}

	if boxDto.WorkingDir != "" {
		opts = append(opts, boxlite.WithWorkDir(boxDto.WorkingDir))
	}

	// Only when the caller asked. 16d9248bb removed the unconditional
	// WithUser(OsUser) because the default landed a USER override on images
	// that never defined that account; an explicit RunAsUser is the caller's
	// own choice and their image's problem if it is wrong.
	if boxDto.RunAsUser != "" {
		opts = append(opts, boxlite.WithUser(boxDto.RunAsUser))
	}

	volumeMounts, err := c.getVolumeMounts(ctx, boxDto.Volumes)
	if err != nil {
		return "", "", err
	}
	for _, vol := range volumeMounts {
		// The bucket is already FUSE-mounted on this host, so the runner is a
		// host-bind consumer even though the box is mounting a managed volume.
		opts = append(opts, boxlite.WithBindMount(vol.hostPath, vol.mountPath))
	}

	if len(volumeMounts) > 0 {
		if err := c.recordBoxVolumeMounts(ctx, boxDto.Id, volumeMounts); err != nil {
			return "", "", err
		}
	}

	opts = append(opts, boxlite.WithNetwork(networkSpec(boxDto.NetworkBlockAll, boxDto.NetworkAllowList)))

	// GetOrCreate (not Create) so a CREATE_BOX replay is idempotent. The local
	// box name is boxDto.Id — the control plane's globally-unique box id — so if
	// the box was already persisted by a prior CREATE_BOX for the SAME box (e.g.
	// the host rebooted before the job was marked COMPLETED and the poller is
	// replaying the still-IN_PROGRESS job), the core adopts it instead of
	// failing with "already exists", which the API would surface as a 400.
	// The created flag (new vs adopted) is irrelevant here: either way the box
	// now exists locally and the job can proceed, so it is discarded.
	bx, _, err := c.runtime.GetOrCreate(ctx, boxDto.Image, opts...)
	if err != nil {
		if len(volumeMounts) > 0 {
			if cleanupErr := c.removeBoxVolumeMountRecord(ctx, boxDto.Id); cleanupErr != nil {
				c.logger.WarnContext(ctx, "failed to remove box volume mount record after create failure", "box", boxDto.Id, "error", cleanupErr)
			}
		}
		return "", "", fmt.Errorf("failed to create box: %w", err)
	}

	c.mu.Lock()
	c.boxes[boxDto.Id] = bx
	c.mu.Unlock()

	c.logger.Info(
		"created box",
		"id",
		bx.ID(),
		"boxId",
		boxDto.Id,
		"name",
		bx.Name(),
		"image",
		boxDto.Image,
	)

	// bx.Start must stay the last step of Create that can fail.
	//
	// A successful Start publishes StartedAt when BoxLite moves the box to Running,
	// and BoxSync reads it as evidence this job body succeeded — it is what
	// lets a lost job-completion callback be repaired later. A fallible step
	// added below would publish that evidence for a Create that then returns
	// an error, and the two would disagree with no way to tell which is right.
	// TestCreateHasNoFallibleStepAfterStart enforces this.
	skipStart := boxDto.SkipStart != nil && *boxDto.SkipStart
	if !skipStart {
		if err := bx.Start(ctx); err != nil {
			return bx.ID(), "", fmt.Errorf("failed to start box: %w", err)
		}
	}

	return bx.ID(), "boxlite", nil
}

// Start starts a stopped box and returns the runtime version.
func (c *Client) Start(ctx context.Context, boxId string, authToken *string, metadata map[string]string) (string, error) {
	if err := c.ensureVolumeMountsFromMetadata(ctx, boxId, metadata); err != nil {
		c.logger.ErrorContext(ctx, "failed to ensure volume FUSE mounts", "error", err)
	}

	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return "", err
	}
	if err := bx.Start(ctx); err != nil {
		return "", err
	}
	return "boxlite", nil
}

// Stop stops a running box.
func (c *Client) Stop(ctx context.Context, boxId string, force bool) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	err = bx.Stop(ctx)

	// The stopped box's handle is spent either way, so drop it from the cache.
	c.evictBox(boxId, bx)

	return err
}

// Destroy removes a box entirely.
func (c *Client) Destroy(ctx context.Context, boxId string) error {
	c.mu.Lock()
	if bx, ok := c.boxes[boxId]; ok {
		bx.Close()
		delete(c.boxes, boxId)
	}
	c.mu.Unlock()

	if err := c.runtime.ForceRemove(ctx, boxId); err != nil {
		return err
	}

	if err := c.removeBoxVolumeMountRecord(ctx, boxId); err != nil {
		c.logger.WarnContext(ctx, "failed to remove box volume mount record", "box", boxId, "error", err)
	}
	c.CleanupOrphanedVolumeMounts(ctx)

	return nil
}

// ToBoxState maps a box's local lifecycle state onto the control plane's
// vocabulary, one arm per state the runtime can report. Unknown is not a
// neutral default: the API counts it as compute-consuming while Error is not,
// so Failed must map explicitly to Error.
//
// Exported apart from GetBoxState because a caller that already holds a
// BoxInfo must not fetch a second one: BoxSync pairs the state with the box's
// StartedAt, and reading the two at different moments is what lets a stale
// timestamp meet a fresh state.
func ToBoxState(state boxlite.State) enums.BoxState {
	switch state {
	case boxlite.StateRunning:
		return enums.BoxStateStarted
	case boxlite.StatePaused:
		// vCPUs frozen for a snapshot's point-in-time consistency. The VM is up,
		// so the control plane should keep seeing the box as started.
		return enums.BoxStateStarted
	case boxlite.StateStopping:
		return enums.BoxStateStopping
	case boxlite.StateStopped:
		return enums.BoxStateStopped
	case boxlite.StateConfigured:
		// Persisted but never booted. The control plane has no "configured" of
		// its own, so this stays folded into Creating.
		return enums.BoxStateCreating
	case boxlite.StateFailed:
		return enums.BoxStateError
	default:
		return enums.BoxStateUnknown
	}
}

// GetBoxState returns the current state of a box.
//
// It reads through the runtime rather than the handle cache. The box sync loop
// calls this for every box on a 10s ticker (services/box_sync.go), and a state
// read needs no bootable handle — only the persisted record. Routing it through
// getOrFetchBox would evict and re-fetch a handle for every non-running box on
// every tick, and eviction cannot free the old one (see evictBox), so the
// runner would accumulate dead handles for as long as it ran.
func (c *Client) GetBoxState(ctx context.Context, boxId string) (enums.BoxState, error) {
	info, err := c.runtime.GetInfo(ctx, boxId)
	if err != nil {
		if boxlite.IsNotFound(err) {
			return enums.BoxStateUnknown, nil
		}
		return enums.BoxStateUnknown, err
	}

	return ToBoxState(info.State), nil
}

// StartExecution starts an interactive execution in a box.
func (c *Client) StartExecution(ctx context.Context, boxId string, command string, args []string, stdout, stderr io.Writer, tty bool) (*boxlite.Execution, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return nil, err
	}
	return bx.StartExecution(ctx, command, args, &boxlite.ExecutionOptions{
		TTY:    tty,
		Stdout: stdout,
		Stderr: stderr,
	})
}

// Exec executes a command in a running box and returns the result.
func (c *Client) Exec(ctx context.Context, boxId string, command string, args ...string) (*ExecResult, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return nil, err
	}

	result, err := bx.Exec(ctx, command, args...)
	if err != nil {
		return nil, err
	}

	return &ExecResult{
		StdOut:   result.Stdout,
		StdErr:   result.Stderr,
		ExitCode: result.ExitCode,
	}, nil
}

// CopyInto copies a file from host into a box.
func (c *Client) CopyInto(ctx context.Context, boxId string, hostSrc, guestDst string) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyInto(ctx, hostSrc, guestDst)
}

// CopyOut copies a file from a box to the host.
func (c *Client) CopyOut(ctx context.Context, boxId string, guestSrc, hostDst string) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyOut(ctx, guestSrc, hostDst)
}

// CopyInStream streams raw tar bytes from r into guestDst without staging.
func (c *Client) CopyInStream(ctx context.Context, boxId, guestDst string, sourceIsDir bool, r io.Reader) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyInStream(ctx, guestDst, sourceIsDir, r)
}

// CopyOutStream streams a tar of guestSrc to w without staging.
func (c *Client) CopyOutStream(ctx context.Context, boxId, guestSrc string, w io.Writer, onMeta func(bool)) error {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return err
	}
	return bx.CopyOutStream(ctx, guestSrc, w, onMeta)
}

// ListImages returns all locally cached images.
func (c *Client) ListImages(ctx context.Context) ([]boxlite.ImageInfo, error) {
	images, err := c.runtime.Images()
	if err != nil {
		return nil, err
	}
	defer images.Close()
	return images.List(ctx)
}

// Ping checks if the BoxLite runtime is healthy.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.runtime.Metrics(ctx)
	return err
}

// Metrics returns runtime-level metrics.
func (c *Client) Metrics(ctx context.Context) (*boxlite.RuntimeMetrics, error) {
	return c.runtime.Metrics(ctx)
}

// BoxMetrics returns metrics for a specific box.
func (c *Client) BoxMetrics(ctx context.Context, boxId string) (*boxlite.BoxMetrics, error) {
	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return nil, err
	}
	return bx.Metrics(ctx)
}

// ListInfo returns info for all boxes managed by this runtime.
func (c *Client) ListInfo(ctx context.Context) ([]boxlite.BoxInfo, error) {
	return c.runtime.ListInfo(ctx)
}

// GetBox retrieves a box handle from cache or fetches it from the runtime.
func (c *Client) GetBox(ctx context.Context, boxId string) (*boxlite.Box, error) {
	return c.getOrFetchBox(ctx, boxId)
}

// getOrFetchBox retrieves a box handle from cache or fetches it from the runtime.
//
// A cached handle is only good while its box is up. A box can stop *itself* —
// its main command exits and the guest powers the VM off — and such a handle is
// spent: it holds the dead VM and can never boot another. Stop evicts its own
// handle, but nothing was clearing this entry on a self-stop, so every later
// Start, exec, copy or metrics call on that box was answered with the corpse,
// forever. The core invalidates its own cache from the exit watcher; this one
// is ours.
//
// So a box that is no longer running gets a fresh handle, which *can* boot it.
// That is the auto-restart the control plane depends on: its reaper stops idle
// boxes and the next call is expected to bring them back.
func (c *Client) getOrFetchBox(ctx context.Context, boxId string) (*boxlite.Box, error) {
	c.mu.RLock()
	cached, ok := c.boxes[boxId]
	c.mu.RUnlock()

	if ok {
		// Info reads persisted state — it never boots the box, so it is safe to
		// ask a spent handle.
		info, err := cached.Info(ctx)
		if err != nil {
			return nil, err
		}
		// Paused counts as up: the VM is frozen for a snapshot's point-in-time
		// consistency, not stopped, and its handle still drives a live machine.
		// The Rust sibling gates on the same pair via BoxStatus::is_active.
		if info.State == boxlite.StateRunning || info.State == boxlite.StatePaused {
			return cached, nil
		}
		c.evictBox(boxId, cached)
	}

	bx, err := c.runtime.Get(ctx, boxId)
	if err != nil {
		return nil, fmt.Errorf("box %s not found: %w", boxId, err)
	}

	c.mu.Lock()
	c.boxes[boxId] = bx
	c.mu.Unlock()

	return bx, nil
}

// evictBox unmaps a handle so the next lookup fetches a fresh one, and only
// while it is still the cached one — a concurrent Create or fetch may already
// have replaced it, and unmapping the winner would drop a live entry.
//
// It deliberately does not Close the handle. getOrFetchBox hands the same
// *boxlite.Box to every caller and the runner serializes nothing per box, so
// freeing here would pull the FFI handle out from under a goroutine mid-call.
// An unmapped handle is instead leaked for the process lifetime — Close only
// frees what is still in the map. The cost is one handle per request that finds
// its box down: calls that go on to boot it stop there, while ones that refuse a
// stopped box (metrics, a guest-port dial) pay it again on every retry. That is
// affordable only because it tracks request volume — which is why GetBoxState,
// run for every box on a timer, deliberately does not come through here.
// Ref-counting the wrapper is the real fix, and it belongs in the SDK.
func (c *Client) evictBox(boxId string, stale *boxlite.Box) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if current, ok := c.boxes[boxId]; ok && current == stale {
		delete(c.boxes, boxId)
	}
}

// ExecResult holds the output of a command execution.
type ExecResult struct {
	StdOut   string
	StdErr   string
	ExitCode int
}
