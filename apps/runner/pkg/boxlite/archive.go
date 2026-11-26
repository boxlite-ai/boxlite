// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"fmt"
	"os"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func (c *Client) ExportCheckpoint(ctx context.Context, boxId, destDir string) (string, string, error) {
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return "", "", err
	}
	defer operation.Close()
	ctx = context.WithoutCancel(ctx)
	info, err := c.nativeBoxInfo(ctx, boxId)
	if err != nil {
		return "", "", err
	}
	if info.State != boxlite.StateStopped {
		return "", "", fmt.Errorf("checkpoint source must be stopped; stop the Box before creating a checkpoint")
	}
	digest := ""
	if info.ResolvedImage != nil {
		digest = info.ResolvedImage.ManifestDigest
	}
	pinned, err := checkpoint.PinImage(info.Image, digest)
	if err != nil {
		return "", "", err
	}
	archive, err := c.exportBox(ctx, boxId, destDir)
	return archive, pinned, err
}

// ExportBox packs a box into a portable .boxlite archive inside destDir and
// returns the archive path the runtime chose. The caller owns the file — the
// runtime never deletes it.
func (c *Client) ExportBox(ctx context.Context, boxId, destDir string, authorize ...func() error) (string, error) {
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return "", err
	}
	defer operation.Close()
	if len(authorize) != 0 {
		if err := authorize[0](); err != nil {
			return "", err
		}
	}
	return c.exportBox(context.WithoutCancel(ctx), boxId, destDir)
}

func (c *Client) exportBox(ctx context.Context, boxId, destDir string) (string, error) {
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create export directory %s: %w", destDir, err)
	}

	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return "", err
	}

	archivePath, err := bx.Export(ctx, destDir)
	if err != nil {
		return "", fmt.Errorf("failed to export box %s: %w", boxId, err)
	}

	c.logger.InfoContext(ctx, "exported box", "box", boxId, "archive", archivePath)

	return archivePath, nil
}

// ImportBox restores an archive as a stopped box named after the control
// plane's box id, which is how every other runner call addresses it.
//
// An IMPORT_BOX job can be redelivered — the runner can restart between the
// import finishing and the job being marked COMPLETED — and importing twice
// would leave a second box holding the same disk. A box that is already present
// therefore satisfies the job.
func (c *Client) ImportBox(ctx context.Context, boxId, archivePath string) error {
	return c.importBox(ctx, boxId, archivePath, "", nil)
}

func (c *Client) ImportMigrationBox(ctx context.Context, boxId, archivePath, attemptID string, authorize func() error) error {
	return c.importBox(ctx, boxId, archivePath, attemptID, authorize)
}

func (c *Client) importBox(ctx context.Context, boxId, archivePath, attemptID string, authorize func() error) error {
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return err
	}
	defer operation.Close()
	if authorize != nil {
		if err := authorize(); err != nil {
			return err
		}
	}
	ctx = context.WithoutCancel(ctx)
	info, err := c.nativeBoxInfo(ctx, boxId)
	if err != nil && !boxlite.IsNotFound(err) {
		return err
	}
	if info != nil {
		if attemptID != "" {
			if err := c.requireMigrationCopy(ctx, attemptID, info.ID); err != nil {
				return err
			}
		}
		c.logger.InfoContext(ctx, "import skipped, box already present", "box", boxId)
		return nil
	}

	var bx *boxlite.Box
	if attemptID != "" {
		bx, err = c.runtime.ImportRunnerMigration(ctx, archivePath, boxId, attemptID)
	} else {
		bx, err = c.runtime.Import(ctx, archivePath, boxId)
	}
	if err != nil {
		return fmt.Errorf("failed to import box %s from %s: %w", boxId, archivePath, err)
	}

	c.mu.Lock()
	c.boxes[boxId] = bx
	c.mu.Unlock()

	c.logger.InfoContext(ctx, "imported box", "box", boxId, "id", bx.ID(), "archive", archivePath)

	return nil
}

func (c *Client) requireMigrationCopy(ctx context.Context, attemptID, nativeID string) error {
	native, err := c.runtime.Get(ctx, nativeID)
	if err != nil {
		return err
	}
	defer native.Close()
	owner, err := native.RunnerMigration(ctx)
	if err != nil {
		return err
	}
	if owner != attemptID {
		return fmt.Errorf("existing Box does not belong to migration attempt %s", attemptID)
	}
	return nil
}
