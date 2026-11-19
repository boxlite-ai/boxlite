package boxlite

import (
	"context"
	"encoding/json"
	"errors"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
	"github.com/containerd/errdefs"
)

var errProtectedBox = errors.New("protected Box requires coordinated recovery or removal")

type ProtectedBootAdmission struct {
	RunnerID     string `json:"runner_id"`
	NativeID     string `json:"native_id"`
	StartClaimed bool   `json:"start_claimed"`
	Epoch        string `json:"epoch"`
}

type protectedEvidence struct {
	Key              json.RawMessage `json:"key"`
	Epoch            *string         `json:"epoch"`
	Outcome          string          `json:"outcome"`
	NativeID         string          `json:"nativeId,omitempty"`
	AllocationClosed bool            `json:"allocationClosed,omitempty"`
	NoSpawn          bool            `json:"noSpawn,omitempty"`
}

func (c *Client) AuthorizedProtectedBoot(
	ctx context.Context,
	boxID, attempt string,
	operation boxlite.ProtectedBootOperation,
	payload any,
	authorize func(context.Context, string) (ProtectedBootAdmission, error),
) (json.RawMessage, error) {
	lease, err := c.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	if err := lease.CheckIdle(); err != nil {
		return nil, err
	}
	if operation == boxlite.ProtectedBootStart && c.protectedAllocationStopping.Load() {
		return nil, errdefs.ErrUnavailable.WithMessage("Runner allocations are draining")
	}
	owner, err := lease.ProtectedAllocation()
	if err != nil {
		return nil, err
	}
	proof, err := lease.ProtectedRetirement(attempt)
	if err != nil {
		return nil, err
	}
	var nativeID string
	if owner != nil && owner.AttemptID == attempt {
		nativeID = owner.NativeID
	}
	grant, err := authorize(ctx, nativeID)
	if err != nil {
		return nil, err
	}
	if proof != nil && proof.Complete && operation != boxlite.ProtectedBootStart {
		return proof.Receipt, nil
	}
	if operation == boxlite.ProtectedBootRetire {
		if owner != nil && owner.AttemptID != attempt {
			return nil, errProtectedBox
		}
		return c.retireAuthorizedAllocation(ctx, lease, boxID, attempt, nativeID, payload, grant, proof)
	}
	if proof != nil || nativeID == "" || nativeID != grant.NativeID {
		return nil, errProtectedBox
	}
	box, err := c.runtime.Get(ctx, nativeID)
	if err != nil {
		return nil, err
	}
	defer box.Close()
	tag, err := box.RunnerAllocation(ctx)
	if err != nil {
		return nil, err
	}
	if box.ID() != nativeID || tag != attempt {
		return nil, errProtectedBox
	}
	result, err := box.RunnerProtectedBoot(ctx, operation, payload)
	if err != nil {
		return nil, err
	}
	var evidence protectedEvidence
	if err := json.Unmarshal(result, &evidence); err != nil {
		return nil, err
	}
	if evidence.Outcome == "confirmed" && !owner.Booted {
		owner.Booted = true
		owner.BootAttempt = attempt
		if err := lease.SaveProtectedAllocation(*owner); err != nil {
			return nil, err
		}
	}
	evidence.NativeID = nativeID
	return json.Marshal(evidence)
}

func (c *Client) retireAuthorizedAllocation(
	ctx context.Context, lease *checkpoint.TargetLease,
	boxID, attempt, nativeID string, payload any,
	grant ProtectedBootAdmission, proof *checkpoint.ProtectedRetirement,
) (json.RawMessage, error) {
	if !grant.StartClaimed {
		if err := c.closeProtectedPlaceholder(ctx, lease, boxID, attempt); err != nil {
			return nil, err
		}
		key, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		receipt, err := json.Marshal(protectedEvidence{
			Key: key, Outcome: "retired", NativeID: grant.NativeID, AllocationClosed: true, NoSpawn: true,
		})
		if err != nil {
			return nil, err
		}
		err = lease.SaveProtectedRetirement(attempt, checkpoint.ProtectedRetirement{
			NativeID: grant.NativeID, Receipt: receipt, Complete: true,
		})
		return receipt, err
	}
	if grant.NativeID == "" || (proof == nil && nativeID != grant.NativeID) {
		return nil, errProtectedBox
	}
	if proof == nil {
		box, err := c.runtime.Get(ctx, nativeID)
		if err != nil {
			return nil, err
		}
		receipt, err := box.RunnerProtectedBoot(ctx, boxlite.ProtectedStopAndRetire, payload)
		box.Close()
		if err != nil {
			return nil, err
		}
		proof = &checkpoint.ProtectedRetirement{NativeID: nativeID, Receipt: receipt}
		if err := lease.SaveProtectedRetirement(attempt, *proof); err != nil {
			return nil, err
		}
	}
	if proof.NativeID != grant.NativeID {
		return nil, errProtectedBox
	}
	var evidence protectedEvidence
	if err := json.Unmarshal(proof.Receipt, &evidence); err != nil {
		return nil, err
	}
	if evidence.Outcome != "retired" || (grant.Epoch != "" && (evidence.Epoch == nil || *evidence.Epoch != grant.Epoch)) {
		return nil, errProtectedBox
	}
	if err := lease.CloseProtectedAllocation(attempt); err != nil {
		return nil, err
	}
	box, err := c.runtime.Get(ctx, proof.NativeID)
	if err == nil {
		if box.ID() != proof.NativeID {
			box.Close()
			return nil, errProtectedBox
		}
		_, err = box.RunnerProtectedBoot(ctx, boxlite.ProtectedRemoveRetiredAllocation, proof.Receipt)
		box.Close()
	}
	if err != nil && !boxlite.IsNotFound(err) {
		return nil, err
	}
	name := (checkpoint.ProtectedAllocation{BoxID: boxID, AttemptID: attempt}).NativeName()
	if err := c.confirmNativeAllocationAbsent(ctx, name); err != nil {
		return nil, err
	}
	if err := c.removeBoxVolumeMountRecord(ctx, name); err != nil {
		return nil, err
	}
	if err := confirmAllocationVolumeRecordAbsent(name); err != nil {
		return nil, err
	}
	if err := lease.ClearProtectedAllocation(); err != nil {
		return nil, err
	}
	evidence.NativeID = proof.NativeID
	evidence.AllocationClosed = true
	evidence.NoSpawn = evidence.Epoch == nil
	receipt, err := json.Marshal(evidence)
	if err != nil {
		return nil, err
	}
	err = lease.SaveProtectedRetirement(attempt, checkpoint.ProtectedRetirement{
		NativeID: proof.NativeID, Receipt: receipt, Complete: true,
	})
	return receipt, err
}

// ProtectedBoot shares the admission lease with creation and removal. Runtime
// then acquires the lifecycle lock before admitting or retiring the attempt.
func (c *Client) ProtectedBoot(ctx context.Context, boxID string, operation boxlite.ProtectedBootOperation, payload any) (json.RawMessage, error) {
	lease, err := c.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	if err := lease.CheckIdle(); err != nil {
		return nil, err
	}
	box, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	return box.RunnerProtectedBoot(ctx, operation, payload)
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
