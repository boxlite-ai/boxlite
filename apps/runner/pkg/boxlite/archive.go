// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"fmt"
	"os"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// ExportBox packs a box into a portable .boxlite archive inside destDir and
// returns the archive path the runtime chose. The caller owns the file — the
// runtime never deletes it.
func (c *Client) ExportBox(ctx context.Context, boxId, destDir string) (string, error) {
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
	present, err := c.boxPresent(ctx, boxId)
	if err != nil {
		return err
	}
	if present {
		c.logger.InfoContext(ctx, "import skipped, box already present", "box", boxId)
		return nil
	}

	bx, err := c.runtime.Import(ctx, archivePath, boxId)
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
	if _, err := c.runtime.GetInfo(ctx, boxId); err != nil {
		if boxlite.IsNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("failed to look up box %s: %w", boxId, err)
	}
	return true, nil
}
