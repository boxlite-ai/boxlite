// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

type completeCreatePreparation struct {
	owner    checkpoint.CompleteCreateOwner
	prepared boxlite.PreparedOutboundCreate
	rebuild  bool
}

func completeCreateOwner(target string, attempt dto.CompleteCreateAttempt) (checkpoint.CompleteCreateOwner, error) {
	prepared := attempt.Prepared
	snapshot := prepared.Snapshot
	if !boxlite.ValidOutboundRevision(target) || attempt.Incarnation != target ||
		!boxlite.ValidOutboundRevision(attempt.AttemptID) || attempt.Generation == 0 ||
		((attempt.JobID != "" || attempt.ClaimID != "") &&
			(!boxlite.ValidOutboundRevision(attempt.JobID) || !boxlite.ValidOutboundRevision(attempt.ClaimID))) ||
		!boxlite.ValidOutboundRevision(snapshot.Revision) || snapshot.Revision == "initial" ||
		snapshot.Admission != boxlite.OutboundAdmissionExtendedIPv4 ||
		snapshot.Policy.AllowNet == nil || snapshot.Policy.DenyNet == nil ||
		prepared.DenyPresent == nil || (!*prepared.DenyPresent && len(snapshot.Policy.DenyNet) != 0) {
		return checkpoint.CompleteCreateOwner{}, &boxlite.Error{Code: boxlite.ErrInvalidArgument, Message: "invalid complete create identity"}
	}
	var identity any = prepared
	if attempt.JobID != "" {
		identity = attempt
	}
	canonical, err := json.Marshal(identity)
	if err != nil {
		return checkpoint.CompleteCreateOwner{}, err
	}
	fingerprint := sha256.Sum256(canonical)
	return checkpoint.CompleteCreateOwner{
		Incarnation: attempt.Incarnation,
		AttemptID:   attempt.AttemptID,
		Generation:  attempt.Generation,
		Fingerprint: hex.EncodeToString(fingerprint[:]),
	}, nil
}

// CreateCompleteOutbound owns the logical target until the native operation
// returns. A replay can read the installation but never starts provisioning.
func (c *Client) CreateCompleteOutbound(ctx context.Context, target string, request dto.CompleteCreateRequest) (dto.CompleteCreateResult, error) {
	box, attempt := request.Box, request.Attempt
	if box.Id != target || box.Image == "" || box.OutboundEnabled != nil || len(box.OutboundAllowNet) != 0 ||
		(box.SkipStart != nil && *box.SkipStart) {
		return dto.CompleteCreateResult{}, &boxlite.Error{Code: boxlite.ErrInvalidArgument, Message: "invalid complete create configuration"}
	}
	owner, err := completeCreateOwner(target, attempt)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	lease, err := c.checkpointOperations().Lock(ctx, target)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	defer lease.Close()
	phase, err := lease.CompleteCreateState(owner)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	switch phase {
	case checkpoint.CompleteCreateFenced:
		return dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreateNoEffect}, nil
	case checkpoint.CompleteCreateUnsupported:
		return dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreateNoEffect, Failure: "unsupported"}, nil
	case checkpoint.CompleteCreateProvisioning:
		return c.observeCompleteCreate(ctx, target, attempt)
	}
	resources, err := validateCreateResources(box)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	if err := validateRecreatableSecrets(box.Secrets); err != nil {
		return dto.CompleteCreateResult{}, err
	}
	if err := c.requireAbsentCreateTarget(ctx, target); err != nil {
		return dto.CompleteCreateResult{}, err
	}
	if phase == "" {
		if err := lease.ReserveCompleteCreate(owner); err != nil {
			return dto.CompleteCreateResult{}, err
		}
	}
	// An enabled NIC is required even when the complete policy denies all
	// outbound traffic. The Runtime installs the supplied complete snapshot.
	network := boxlite.NetworkSpec{Outbound: boxlite.OutboundNetworkSpec{Mode: boxlite.NetworkModeEnabled}}
	prepared := completeCreatePreparation{owner: owner, prepared: boxlite.PreparedOutboundCreate{
		Snapshot: attempt.Prepared.Snapshot, DenyPresent: *attempt.Prepared.DenyPresent,
	}}
	if _, _, err := c.create(ctx, box, lease, resources, network, &prepared); err != nil {
		return dto.CompleteCreateResult{}, err
	}
	return c.observeCompleteCreate(context.WithoutCancel(ctx), target, attempt)
}

// CancelCompleteOutboundCreate settles a matching attempt using a durable
// fence or live readback. An ambiguous provisioning attempt stays pending.
func (c *Client) CancelCompleteOutboundCreate(ctx context.Context, target string, attempt dto.CompleteCreateAttempt) (dto.CompleteCreateResult, error) {
	owner, err := completeCreateOwner(target, attempt)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	lease, err := c.checkpointOperations().Lock(ctx, target)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	defer lease.Close()
	phase, err := lease.CompleteCreateState(owner)
	if err != nil {
		return dto.CompleteCreateResult{}, err
	}
	if phase == checkpoint.CompleteCreateProvisioning {
		return c.observeCompleteCreate(ctx, target, attempt)
	}
	if phase == checkpoint.CompleteCreateUnsupported {
		return dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreateNoEffect, Failure: "unsupported"}, nil
	}
	if phase != checkpoint.CompleteCreateFenced {
		if err := c.requireAbsentCreateTarget(ctx, target); err != nil {
			return dto.CompleteCreateResult{}, err
		}
		if err := lease.FenceCompleteCreate(owner, phase); err != nil {
			return dto.CompleteCreateResult{}, err
		}
	}
	return dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreateNoEffect}, nil
}

func (c *Client) requireAbsentCreateTarget(ctx context.Context, target string) error {
	_, err := c.runtime.GetInfo(ctx, target)
	switch {
	case boxlite.IsNotFound(err):
		return nil
	case err != nil:
		return err
	default:
		return checkpoint.ErrCompleteCreateConflict
	}
}

func (c *Client) observeCompleteCreate(ctx context.Context, target string, attempt dto.CompleteCreateAttempt) (dto.CompleteCreateResult, error) {
	result := dto.CompleteCreateResult{Attempt: attempt, Outcome: dto.CompleteCreatePending}
	info, err := c.runtime.GetInfo(ctx, target)
	if boxlite.IsNotFound(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if info.State != boxlite.StateRunning {
		return result, nil
	}
	status, err := c.CompleteOutboundStatus(ctx, target)
	if err != nil {
		return result, err
	}
	expected := attempt.Prepared.Snapshot
	if status.Observed != nil && status.ApplicationState == boxlite.OutboundConfirmed &&
		status.Observed.ApplicationState == boxlite.OutboundConfirmed &&
		status.PendingRevision == "" && status.ObservationError == "" &&
		sameCompleteCreateSnapshot(expected, status.Persisted) &&
		sameCompleteCreateSnapshot(expected, status.Observed.Snapshot) {
		result.Outcome = dto.CompleteCreateInstalled
		result.Snapshot = &status.Persisted
	}
	return result, nil
}

func sameCompleteCreateSnapshot(left, right boxlite.CompleteOutboundSnapshot) bool {
	return left.Revision == right.Revision && left.Admission == right.Admission &&
		left.Policy.Mode == right.Policy.Mode &&
		slices.Equal(left.Policy.AllowNet, right.Policy.AllowNet) &&
		slices.Equal(left.Policy.DenyNet, right.Policy.DenyNet)
}
