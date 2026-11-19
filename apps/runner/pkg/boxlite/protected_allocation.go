// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
	"golang.org/x/sys/unix"
)

func (c *Client) stopProtectedPreparation() {
	c.protectedAllocationStopping.Store(true)
	if c.cancelProtectedPreparation != nil {
		c.cancelProtectedPreparation()
	}
}

type ProtectedPreparation struct {
	AttemptID   string
	Fingerprint string
	Authorize   func(context.Context) error
}

func (c *Client) AllocateProtectedPlaceholder(ctx context.Context, request dto.CreateBoxDTO, preparation ProtectedPreparation) (string, error) {
	if preparation.AttemptID == "" || preparation.Fingerprint == "" || preparation.Authorize == nil {
		return "", errdefs.ErrInvalidArgument.WithMessage("protected allocation needs an attempt")
	}
	c.protectedAllocationShutdown.RLock()
	defer c.protectedAllocationShutdown.RUnlock()
	if c.protectedAllocationStopping.Load() {
		return "", errdefs.ErrUnavailable.WithMessage("Runner allocations are draining")
	}
	if c.protectedPreparationContext != nil {
		requestContext, cancel := context.WithCancel(ctx)
		unsubscribe := context.AfterFunc(c.protectedPreparationContext, cancel)
		defer cancel()
		defer unsubscribe()
		ctx = requestContext
	}
	stop, outbound := true, false
	request.SkipStart = &stop
	request.OutboundEnabled = &outbound
	request.OutboundAllowNet = nil
	id, _, err := c.createBox(ctx, request, &preparation)
	return id, err
}

func (c *Client) reserveProtectedAllocation(ctx context.Context, lease *checkpoint.TargetLease, boxID string, preparation ProtectedPreparation) (*checkpoint.ProtectedAllocation, bool, error) {
	attempt := preparation.AttemptID
	if err := preparation.Authorize(ctx); err != nil {
		return nil, false, err
	}
	closed, err := lease.ProtectedAllocationClosed(attempt)
	if err != nil {
		return nil, false, err
	}
	if closed {
		return nil, false, errdefs.ErrFailedPrecondition.WithMessage("protected allocation is closed")
	}
	owner, err := lease.ProtectedAllocation()
	if err != nil {
		return nil, false, err
	}
	if owner != nil {
		if owner.AttemptID != attempt || owner.Fingerprint != preparation.Fingerprint || owner.BootAttempt != "" {
			return nil, false, errProtectedBox
		}
		info, err := c.runtime.GetInfo(ctx, owner.NativeName())
		if boxlite.IsNotFound(err) && owner.NativeID == "" && !owner.InFlight {
			owner.CreatorPID = os.Getpid()
			return owner, false, lease.SaveProtectedAllocation(*owner)
		}
		if err != nil {
			return nil, false, err
		}
		if err := c.checkConfiguredAllocation(ctx, info, *owner, false); err != nil {
			return nil, false, err
		}
		owner.NativeID = info.ID
		owner.InFlight = false
		return owner, true, lease.SaveProtectedAllocation(*owner)
	}
	if _, err := c.nativeBoxInfo(ctx, boxID); !boxlite.IsNotFound(err) {
		if err == nil {
			err = errProtectedBox
		}
		return nil, false, err
	}
	owner = &checkpoint.ProtectedAllocation{
		BoxID: boxID, AttemptID: attempt, Fingerprint: preparation.Fingerprint, CreatorPID: os.Getpid(),
	}
	if _, err := c.runtime.GetInfo(ctx, owner.NativeName()); !boxlite.IsNotFound(err) {
		if err == nil {
			err = errProtectedBox
		}
		return nil, false, err
	}
	return owner, false, lease.SaveProtectedAllocation(*owner)
}

func (c *Client) closeProtectedPlaceholder(ctx context.Context, lease *checkpoint.TargetLease, boxID, attempt string) error {
	owner, err := lease.ProtectedAllocation()
	if err != nil {
		return err
	}
	if owner == nil || owner.AttemptID != attempt {
		name := (checkpoint.ProtectedAllocation{BoxID: boxID, AttemptID: attempt}).NativeName()
		if err := c.confirmNativeAllocationAbsent(ctx, name); err != nil {
			return err
		}
		if err := confirmAllocationVolumeRecordAbsent(name); err != nil {
			return err
		}
		return lease.CloseProtectedAllocation(attempt)
	}
	if owner.Booted || (owner.InFlight && !errors.Is(unix.Kill(owner.CreatorPID, 0), unix.ESRCH)) {
		return errProtectedBox
	}
	info, err := c.runtime.GetInfo(ctx, owner.NativeName())
	if err != nil && !boxlite.IsNotFound(err) {
		return err
	}
	if info != nil {
		if err := c.checkConfiguredAllocation(ctx, info, *owner, true); err != nil {
			return err
		}
	}
	if err := lease.CloseProtectedAllocation(attempt); err != nil {
		return err
	}
	ctx = context.WithoutCancel(ctx)
	if info != nil {
		if err := c.runtime.ForceRemove(ctx, info.ID); err != nil && !boxlite.IsNotFound(err) {
			return err
		}
	}
	if err := c.confirmNativeAllocationAbsent(ctx, owner.NativeName()); err != nil {
		return err
	}
	if err := c.removeBoxVolumeMountRecord(ctx, owner.NativeName()); err != nil {
		return err
	}
	if err := confirmAllocationVolumeRecordAbsent(owner.NativeName()); err != nil {
		return err
	}
	c.CleanupOrphanedVolumeMounts(ctx)
	return lease.ClearProtectedAllocation()
}

func (c *Client) confirmNativeAllocationAbsent(ctx context.Context, name string) error {
	if _, err := c.runtime.GetInfo(ctx, name); !boxlite.IsNotFound(err) {
		if err == nil {
			return errProtectedBox
		}
		return err
	}
	return nil
}

func confirmAllocationVolumeRecordAbsent(name string) error {
	if _, err := os.Lstat(filepath.Join(getVolumeMountRecordDir(), name+".json")); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return errProtectedBox
		}
		return err
	}
	return nil
}

func (c *Client) checkConfiguredAllocation(ctx context.Context, info *boxlite.BoxInfo, owner checkpoint.ProtectedAllocation, closing bool) error {
	if info.Name != owner.NativeName() || (owner.NativeID != "" && info.ID != owner.NativeID) ||
		info.State != boxlite.StateConfigured || !info.StartedAt.IsZero() || info.PID != 0 {
		return errProtectedBox
	}
	box, err := c.runtime.Get(ctx, info.ID)
	if err != nil {
		return err
	}
	defer box.Close()
	attempt, err := box.RunnerAllocation(ctx)
	if err != nil {
		return err
	}
	if attempt != owner.AttemptID {
		return errProtectedBox
	}
	if closing {
		protected, err := box.HasRunnerProtection(ctx)
		if err != nil {
			return err
		}
		if protected {
			return errProtectedBox
		}
	}
	return nil
}

func (c *Client) ordinaryAllocationAllowed(boxID string) error {
	if c.homeDir == "" {
		return nil
	}
	allocation, err := c.checkpointOperations().ProtectedAllocation(boxID)
	if err != nil {
		return err
	}
	if allocation != nil && !allocation.Booted {
		return errProtectedBox
	}
	return nil
}

func (c *Client) requireOrdinaryLifecycle(ctx context.Context, lease *checkpoint.TargetLease, boxID string) error {
	owner, err := lease.ProtectedAllocation()
	if err != nil {
		return err
	}
	if owner != nil {
		return errProtectedBox
	}
	id, err := c.nativeBoxID(boxID)
	if err != nil {
		return err
	}
	tag, err := c.nativeRunnerAllocation(ctx, id)
	if boxlite.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if tag != "" {
		return errProtectedBox
	}
	return nil
}

func (c *Client) nativeRunnerAllocation(ctx context.Context, id string) (string, error) {
	box, err := c.runtime.Get(ctx, id)
	if err != nil {
		return "", err
	}
	defer box.Close()
	return box.RunnerAllocation(ctx)
}
