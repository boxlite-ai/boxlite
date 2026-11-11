// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/boxlite-ai/runner/pkg/storage"
)

func (c *Client) checkpointOperations() checkpoint.Operations {
	return checkpoint.Operations{Root: filepath.Join(c.homeDir, "work", "checkpoint-operations")}
}

func (c *Client) lockCheckpointTarget(ctx context.Context, target string) (*checkpoint.TargetLease, error) {
	lease, err := c.checkpointOperations().Lock(ctx, target)
	if err != nil {
		return nil, err
	}
	if err := lease.CheckIdle(); err != nil {
		lease.Close()
		return nil, err
	}
	return lease, nil
}

func (c *Client) RestoreCheckpoint(ctx context.Context, request checkpoint.RestoreRequest, attemptID string, artifacts checkpoint.Artifacts, store storage.ArchiveStore) (checkpoint.RestoreResult, error) {
	restorer := checkpoint.Restorer{
		Operations: c.checkpointOperations(),
		Artifacts:  artifacts,
		Store:      store,
		Backend:    nativeCheckpointRecovery{client: c, target: request.Target},
	}
	return restorer.Restore(ctx, request, attemptID)
}

func (c *Client) RetireCheckpointTarget(ctx context.Context, target string) error {
	lease, err := c.checkpointOperations().Lock(ctx, target)
	if err != nil {
		return err
	}
	defer lease.Close()
	return lease.Retire()
}

// This adapter is invoked with the logical target lease already held. Calling
// public Client lifecycle methods here would acquire that lease recursively.
type nativeCheckpointRecovery struct {
	client *Client
	target string
}

func (n nativeCheckpointRecovery) Lookup(ctx context.Context, target string) (*checkpoint.NativeBox, error) {
	info, err := n.client.runtime.GetInfo(ctx, target)
	if boxlite.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &checkpoint.NativeBox{ID: info.ID, State: string(info.State), PID: info.PID}, nil
}

func (n nativeCheckpointRecovery) Prepare(ctx context.Context, archive *checkpoint.DownloadedArchive, env map[string]string) (checkpoint.PreparedArchive, error) {
	overrides, err := checkpointImportOptions(archive.Artifact.PinnedImage, env)
	if err != nil {
		return nil, err
	}
	prepared, err := n.client.runtime.PrepareImport(ctx, archive.Path, overrides)
	if err != nil {
		return nil, err
	}
	info, err := prepared.Info()
	if err == nil {
		err = validateCheckpointArchive(info)
	}
	if err != nil {
		return nil, errors.Join(err, prepared.Close())
	}
	return prepared, nil
}

var checkpointPlatformEnvKeys = []string{
	"BOXLITE_BOX_ID", "BOXLITE_OTEL_ENDPOINT", "BOXLITE_ORGANIZATION_ID",
	"BOXLITE_REGION_ID", "BOXLITE_TRACEPARENT", "BOXLITE_TRACESTATE",
}

// Cloud identity and archive policy belong to the runner; native import only
// understands generic image/environment overrides and startup preflight.
func checkpointImportOptions(image string, env map[string]string) (boxlite.ImportOptions, error) {
	pinned, err := checkpoint.PinImage(image, "")
	if err != nil {
		return boxlite.ImportOptions{}, err
	}
	if env["BOXLITE_BOX_ID"] == "" {
		return boxlite.ImportOptions{}, fmt.Errorf("checkpoint requires a target box ID")
	}
	patch := make(map[string]*string, len(checkpointPlatformEnvKeys))
	for _, key := range checkpointPlatformEnvKeys {
		patch[key] = nil
	}
	for key, value := range env {
		if !slices.Contains(checkpointPlatformEnvKeys, key) || strings.ContainsRune(value, 0) {
			return boxlite.ImportOptions{}, fmt.Errorf("checkpoint platform environment accepts only reserved identity keys")
		}
		patch[key] = &value
	}
	return boxlite.ImportOptions{Image: pinned, Env: patch, PreflightStartup: true}, nil
}

func validateCheckpointArchive(info boxlite.ImportArchiveInfo) error {
	if info.Version < 3 || len(info.BoxOptions) == 0 || string(info.BoxOptions) == "null" || !info.HasDiskChecksum {
		return fmt.Errorf("checkpoint requires complete box_options and a disk checksum")
	}
	var options struct {
		Rootfs  map[string]json.RawMessage `json:"rootfs"`
		Volumes []json.RawMessage          `json:"volumes"`
		Mounts  []json.RawMessage          `json:"mounts"`
		Secrets []json.RawMessage          `json:"secrets"`
	}
	if err := json.Unmarshal(info.BoxOptions, &options); err != nil {
		return fmt.Errorf("invalid checkpoint options: %w", err)
	}
	if _, image := options.Rootfs["Image"]; !image || len(options.Volumes) != 0 || len(options.Mounts) != 0 || len(options.Secrets) != 0 {
		return fmt.Errorf("checkpoints require an OCI image without volumes, mounts or secrets")
	}
	return nil
}

func (n nativeCheckpointRecovery) Remove(ctx context.Context, nativeID string) error {
	if err := n.client.runtime.Remove(ctx, nativeID); err != nil {
		return err
	}
	n.client.forgetBox(n.target)
	return nil
}

func (n nativeCheckpointRecovery) Import(ctx context.Context, prepared checkpoint.PreparedArchive, target string) (string, error) {
	if target != n.target {
		return "", fmt.Errorf("checkpoint native target changed")
	}
	commit, ok := prepared.(interface {
		Commit(context.Context, string) (*boxlite.Box, error)
	})
	if !ok {
		return "", fmt.Errorf("checkpoint has no prepared native import")
	}
	bx, err := commit.Commit(ctx, target)
	if err != nil {
		return "", err
	}
	n.client.mu.Lock()
	n.client.boxes[target] = bx
	n.client.mu.Unlock()
	return bx.ID(), nil
}
