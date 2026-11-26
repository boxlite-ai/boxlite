package boxlite

import (
	"context"
	"encoding/json"
	"errors"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
)

var errProtectedBox = errors.New("protected Box requires coordinated recovery or removal")

type protectedAllocationSelection struct {
	Key struct {
		AttemptID string `json:"attempt_id"`
	} `json:"key"`
	Restart bool `json:"restart"`
}

func protectedAllocationSelectionFrom(payload any) (protectedAllocationSelection, error) {
	var selection protectedAllocationSelection
	data, err := json.Marshal(payload)
	if err != nil {
		return selection, err
	}
	defer clear(data)
	err = json.Unmarshal(data, &selection)
	return selection, err
}

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
	allocation, err := lease.ProtectedAllocation()
	if err != nil {
		return nil, err
	}
	volumeOwner := boxID
	if allocation != nil {
		volumeOwner = allocation.NativeName()
	}
	if operation == boxlite.ProtectedBootRemove {
		if allocation != nil && allocation.NativeID == "" {
			return c.runtime.RunnerRemoveRetired(ctx, boxID, payload)
		}
		id, err := c.nativeBoxID(boxID)
		if err != nil {
			return nil, err
		}
		request := payload
		if allocation != nil {
			request, err = exactNativeRemoval(payload)
			if err != nil {
				return nil, err
			}
		}
		receipt, err := c.runtime.RunnerRemoveRetired(ctx, id, request)
		if err != nil {
			if allocation != nil && boxlite.IsInvalidState(err) {
				// A historical receipt found by logical name does not settle this native allocation.
				if replay, replayErr := c.runtime.RunnerRemoveRetired(ctx, boxID, payload); replayErr == nil {
					return replay, nil
				}
			}
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
		if err := c.removeBoxVolumeMountRecord(ctx, volumeOwner); err != nil {
			return nil, err
		}
		if allocation != nil {
			if err := lease.CloseProtectedAllocation(allocation.AttemptID); err != nil {
				return nil, err
			}
			if err := lease.ClearProtectedAllocation(); err != nil {
				return nil, err
			}
		}
		c.CleanupOrphanedVolumeMounts(ctx)
		return receipt, nil
	}
	var box *boxlite.Box
	if allocation == nil {
		box, err = c.getOrFetchBox(ctx, boxID)
	} else {
		box, err = c.openProtectedAllocation(ctx, lease, allocation, operation, payload)
	}
	if err != nil {
		return nil, err
	}
	if allocation != nil {
		defer box.Close()
	}
	if operation == boxlite.ProtectedBootStart && len(restartVolumes) != 0 {
		if _, err := c.prepareBoxVolumeMounts(ctx, volumeOwner, restartVolumes, allocation != nil); err != nil {
			if allocation != nil {
				return nil, err
			}
			c.logger.ErrorContext(ctx, "failed to ensure volume FUSE mounts", "error", err)
		}
	}
	receipt, err := box.RunnerProtectedBoot(ctx, operation, payload)
	if err == nil && (operation == boxlite.ProtectedBootStart || operation == boxlite.ProtectedBootRead) {
		var evidence struct {
			Outcome string `json:"outcome"`
			Key     struct {
				AttemptID string `json:"attempt_id"`
			} `json:"key"`
		}
		if json.Unmarshal(receipt, &evidence) == nil && evidence.Outcome == "confirmed" {
			if allocation != nil && (!allocation.Booted || allocation.BootAttempt != evidence.Key.AttemptID) {
				allocation.BootAttempt = evidence.Key.AttemptID
				allocation.Booted = true
				if err := lease.SaveProtectedAllocation(*allocation); err != nil {
					return nil, err
				}
			}
			c.recordPulledImage(ctx, boxID, box)
		}
	}
	return receipt, err
}

func exactNativeRemoval(payload any) (map[string]json.RawMessage, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var removal map[string]json.RawMessage
	if err := json.Unmarshal(data, &removal); err != nil {
		return nil, err
	}
	if removal == nil {
		return nil, errdefs.ErrInvalidArgument.WithMessage("protected removal needs a request")
	}
	removal["exact_native_id"] = json.RawMessage("true")
	return removal, nil
}

func (c *Client) openProtectedAllocation(ctx context.Context, lease *checkpoint.TargetLease, owner *checkpoint.ProtectedAllocation, operation boxlite.ProtectedBootOperation, payload any) (*boxlite.Box, error) {
	closed, err := lease.ProtectedAllocationClosed(owner.AttemptID)
	if err != nil {
		return nil, err
	}
	if closed || owner.InFlight || owner.NativeID == "" {
		return nil, errors.Join(errdefs.ErrFailedPrecondition, errProtectedBox)
	}
	if operation == boxlite.ProtectedBootStart {
		boot, err := protectedAllocationSelectionFrom(payload)
		if err != nil {
			return nil, err
		}
		if (!owner.Booted && (boot.Restart || boot.Key.AttemptID != owner.AttemptID)) ||
			(owner.Booted && !boot.Restart && boot.Key.AttemptID != owner.BootAttempt) ||
			(boot.Restart && boot.Key.AttemptID == owner.AttemptID) {
			return nil, errors.Join(errdefs.ErrFailedPrecondition, errProtectedBox)
		}
		if !owner.Booted && owner.BootAttempt == "" {
			info, err := c.runtime.GetInfo(ctx, owner.NativeName())
			if err != nil {
				return nil, err
			}
			if err := c.checkConfiguredAllocation(ctx, info, *owner, false); err != nil {
				return nil, err
			}
			owner.BootAttempt = boot.Key.AttemptID
			if err := lease.SaveProtectedAllocation(*owner); err != nil {
				return nil, err
			}
		}
	}
	return c.runtime.Get(ctx, owner.NativeID)
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
		attempt, err := box.RunnerAllocation(ctx)
		if err != nil || attempt != "" {
			box.Close()
			if err != nil {
				return err
			}
			return errors.Join(errdefs.ErrFailedPrecondition, errProtectedBox)
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
