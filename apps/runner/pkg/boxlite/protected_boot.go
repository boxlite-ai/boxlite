package boxlite

import (
	"context"
	"encoding/json"
	"errors"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

var errProtectedBox = errors.New("protected Box requires coordinated recovery or removal")

// ProtectedBoot shares the admission lease with creation and removal. Runtime
// then acquires the lifecycle lock before admitting or retiring the attempt.
func (c *Client) ProtectedBoot(ctx context.Context, boxID string, operation boxlite.ProtectedBootOperation, payload any, restartVolumes []dto.VolumeDTO) (json.RawMessage, error) {
	lease, err := c.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	if err := lease.CheckIdle(); err != nil {
		return nil, err
	}
	if operation == boxlite.ProtectedBootRemove {
		id, err := c.nativeBoxID(boxID)
		if err != nil {
			return nil, err
		}
		receipt, err := c.runtime.RunnerRemoveRetired(ctx, id, payload)
		if err != nil {
			return nil, err
		}
		// An exact replay can resolve a retired incarnation while its name is in use again.
		if _, err := c.runtime.GetInfo(ctx, id); err == nil {
			return receipt, nil
		} else if !boxlite.IsNotFound(err) {
			return nil, err
		}
		if err := lease.Invalidate(); err != nil {
			return nil, err
		}
		c.forgetBox(boxID)
		if err := c.removeBoxVolumeMountRecord(ctx, boxID); err != nil {
			return nil, err
		}
		c.CleanupOrphanedVolumeMounts(ctx)
		return receipt, nil
	}
	box, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	if operation == boxlite.ProtectedBootStart && len(restartVolumes) != 0 {
		if err := c.ensureBoxVolumeMounts(ctx, boxID, restartVolumes); err != nil {
			c.logger.ErrorContext(ctx, "failed to ensure volume FUSE mounts", "error", err)
		}
	}
	receipt, err := box.RunnerProtectedBoot(ctx, operation, payload)
	if err == nil && (operation == boxlite.ProtectedBootStart || operation == boxlite.ProtectedBootRead) {
		var evidence struct{ Outcome string }
		if json.Unmarshal(receipt, &evidence) == nil && evidence.Outcome == "confirmed" {
			c.recordPulledImage(ctx, boxID, box)
		}
	}
	return receipt, err
}

func (c *Client) refuseProtectedRemoval(ctx context.Context, ids []string) error {
	for _, id := range ids {
		box, err := c.runtime.Get(ctx, id)
		if boxlite.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		protected, err := box.HasRunnerProtection(ctx)
		box.Close()
		if err != nil {
			return err
		}
		if protected {
			return errors.Join(errdefs.ErrFailedPrecondition, errProtectedBox)
		}
	}
	return nil
}
