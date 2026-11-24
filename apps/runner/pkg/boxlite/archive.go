// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func (c *Client) ExportCheckpoint(ctx context.Context, boxId, destDir string) (string, string, error) {
	return c.exportCheckpoint(ctx, boxId, destDir, nil)
}

func (c *Client) ExportManagedCheckpoint(ctx context.Context, boxId, destDir string, snapshot json.RawMessage) (string, string, error) {
	if len(snapshot) == 0 {
		return "", "", fmt.Errorf("managed capture requires an expected snapshot")
	}
	return c.exportCheckpoint(ctx, boxId, destDir, snapshot)
}

func (c *Client) exportCheckpoint(ctx context.Context, boxId, destDir string, snapshot json.RawMessage) (string, string, error) {
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return "", "", err
	}
	defer operation.Close()
	if err := operation.CheckNoCompleteCreate(); err != nil {
		return "", "", err
	}
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
	if len(snapshot) == 0 {
		archive, err := c.exportBox(ctx, boxId, destDir)
		return archive, pinned, err
	}
	box, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return "", "", err
	}
	archive, err := box.ExportManagedCheckpoint(ctx, destDir, boxlite.CheckpointExportPolicy{
		Snapshot: snapshot, PinnedImage: pinned,
	})
	return archive, pinned, err
}

// ExportBox packs a box into a portable .boxlite archive inside destDir and
// returns the archive path the runtime chose. The caller owns the file — the
// runtime never deletes it.
func (c *Client) ExportBox(ctx context.Context, boxId, destDir string) (string, error) {
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return "", err
	}
	defer operation.Close()
	if err := operation.CheckNoCompleteCreate(); err != nil {
		return "", err
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

	archivePath, err := bx.ExportLegacy(ctx, destDir)
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
	operation, err := c.lockCheckpointTarget(ctx, boxId)
	if err != nil {
		return err
	}
	defer operation.Close()
	if err := operation.CheckNoCompleteCreate(); err != nil {
		return err
	}
	ctx = context.WithoutCancel(ctx)
	present, err := c.boxPresent(ctx, boxId)
	if err != nil {
		return err
	}
	if present {
		if err := boxlite.ValidateLegacyArchive(archivePath); err != nil {
			return err
		}
		c.logger.InfoContext(ctx, "import skipped, box already present", "box", boxId)
		return nil
	}

	bx, err := c.runtime.ImportLegacy(ctx, archivePath, boxId)
	if err != nil {
		return fmt.Errorf("failed to import box %s from %s: %w", boxId, archivePath, err)
	}

	c.mu.Lock()
	c.boxes[boxId] = bx
	c.mu.Unlock()

	c.logger.InfoContext(ctx, "imported box", "box", boxId, "id", bx.ID(), "archive", archivePath)

	return nil
}

// boxPresent reports whether the runtime still holds a record for the box. It
// reads through the runtime rather than the handle cache so it sees boxes this
// process never created — an imported box after a runner restart, for one.
func (c *Client) boxPresent(ctx context.Context, boxId string) (bool, error) {
	if _, err := c.nativeBoxInfo(ctx, boxId); err != nil {
		if boxlite.IsNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("failed to look up box %s: %w", boxId, err)
	}
	return true, nil
}
