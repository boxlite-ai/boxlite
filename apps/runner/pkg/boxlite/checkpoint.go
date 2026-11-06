// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"fmt"
	"path/filepath"

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
	return n.client.runtime.PrepareCheckpointArchive(ctx, boxlite.CheckpointArchiveSource{
		Path: archive.Path, SHA256: archive.Artifact.SHA256, PinnedImage: archive.Artifact.PinnedImage,
	}, env)
}

func (n nativeCheckpointRecovery) Remove(ctx context.Context, nativeID string) error {
	if err := n.client.runtime.Remove(ctx, nativeID); err != nil {
		return err
	}
	n.client.forgetBox(n.target)
	return nil
}

func (n nativeCheckpointRecovery) Import(ctx context.Context, path, target string) (string, error) {
	if target != n.target {
		return "", fmt.Errorf("checkpoint native target changed")
	}
	bx, err := n.client.runtime.Import(ctx, path, target)
	if err != nil {
		return "", err
	}
	n.client.mu.Lock()
	n.client.boxes[target] = bx
	n.client.mu.Unlock()
	return bx.ID(), nil
}
