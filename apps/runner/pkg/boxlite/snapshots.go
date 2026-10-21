package boxlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/google/uuid"
)

func (c *Client) SnapshotGet(ctx context.Context, id string) (*sdk.SnapshotInfo, error) {
	return c.runtime.SnapshotGet(ctx, id)
}

// SnapshotExport reuses the migration archive format without booting a VM or
// carrying mounts. The caller owns destDir and the returned archive file.
func (c *Client) SnapshotExport(ctx context.Context, id, destDir string) (path string, err error) {
	if err = ctx.Err(); err != nil {
		return "", err
	}
	// Accepted FFI operations can outlive cancellation. Await their completion
	// before removing disks; cancellation is checked again before publication.
	work := context.WithoutCancel(ctx)
	box, err := c.runtime.CreateFromSnapshot(work, id, "snapshot-transfer:unused",
		sdk.WithName("snapshot-transfer-"+uuid.NewString()), sdk.WithAutoRemove(false))
	if err != nil {
		return "", err
	}
	defer func() { err = errors.Join(err, c.runtime.ForceRemove(work, box.ID())) }()
	path, err = box.Export(work, destDir)
	if err == nil {
		err = ctx.Err()
	}
	return
}

// SnapshotImport publishes an independent snapshot from a migration archive.
// Neither the temporary imported Box nor its archived options are ever booted.
func (c *Client) SnapshotImport(ctx context.Context, path, name string) (info *sdk.SnapshotInfo, err error) {
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	work := context.WithoutCancel(ctx)
	box, err := c.runtime.Import(work, path, "snapshot-transfer-"+uuid.NewString())
	if err != nil {
		return nil, err
	}
	defer func() {
		err = errors.Join(err, c.runtime.ForceRemove(work, box.ID()), ctx.Err())
		if err != nil && info != nil && info.ID != "" {
			err = errors.Join(err, c.runtime.SnapshotRemove(work, info.ID))
		}
	}()
	info, err = box.Snapshots().Create(work, name, "filesystem")
	return
}

// SnapshotTransferDir keeps large temporary files on the runtime's own volume.
func (c *Client) SnapshotTransferDir() (string, error) {
	root := filepath.Join(c.homeDir, "tmp")
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	return os.MkdirTemp(root, "snapshot-transfer-")
}

func (c *Client) SnapshotRemove(ctx context.Context, id string) error {
	return c.runtime.SnapshotRemove(ctx, id)
}
