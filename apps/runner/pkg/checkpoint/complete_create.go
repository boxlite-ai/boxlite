// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"errors"
	"fmt"
	"regexp"
)

var ErrCompleteCreateConflict = errors.New("target is owned by another Box operation")

type CompleteCreatePhase string

const (
	CompleteCreateReserved     CompleteCreatePhase = "reserved"
	CompleteCreateProvisioning CompleteCreatePhase = "provisioning"
	CompleteCreateFenced       CompleteCreatePhase = "fenced"
	CompleteCreateUnsupported  CompleteCreatePhase = "unsupported"
)

var completeCreateIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// CompleteCreateOwner records the exact intent without storing provisioning inputs.
type CompleteCreateOwner struct {
	Incarnation string `json:"incarnation"`
	AttemptID   string `json:"attempt_id"`
	Generation  uint64 `json:"generation"`
	Fingerprint string `json:"fingerprint"`
}

func (o CompleteCreateOwner) valid() bool {
	return sha256Digest(o.Fingerprint) &&
		completeCreateIdentifier.MatchString(o.Incarnation) &&
		completeCreateIdentifier.MatchString(o.AttemptID) && o.Generation > 0
}

type completeCreateRecord struct {
	Version int                 `json:"version"`
	Target  string              `json:"target"`
	Owner   CompleteCreateOwner `json:"owner"`
	Phase   CompleteCreatePhase `json:"phase"`
}

func (l *TargetLease) completeCreateRecord() (*completeCreateRecord, error) {
	if l.file == nil {
		return nil, fmt.Errorf("target lease is closed")
	}
	var record completeCreateRecord
	found, err := readTargetRecord(l.path+".complete-create", &record)
	if err != nil || !found {
		return nil, err
	}
	if record.Version != 1 || record.Target != l.target || !record.Owner.valid() {
		return nil, fmt.Errorf("invalid complete create target record")
	}
	switch record.Phase {
	case CompleteCreateReserved, CompleteCreateProvisioning, CompleteCreateFenced, CompleteCreateUnsupported:
		return &record, nil
	default:
		return nil, fmt.Errorf("invalid complete create phase")
	}
}

func (l *TargetLease) CheckNoCompleteCreate() error {
	record, err := l.completeCreateRecord()
	if err == nil && record != nil {
		return ErrCompleteCreateConflict
	}
	return err
}

// CompleteCreateState finds the exact attempt, or an available generation.
func (l *TargetLease) CompleteCreateState(owner CompleteCreateOwner) (CompleteCreatePhase, error) {
	if !owner.valid() {
		return "", fmt.Errorf("invalid complete create owner")
	}
	record, err := l.completeCreateRecord()
	if err != nil {
		return "", err
	}
	if record != nil {
		if record.Owner == owner {
			return record.Phase, nil
		}
		if (record.Phase != CompleteCreateFenced && record.Phase != CompleteCreateUnsupported) ||
			owner.Generation <= record.Owner.Generation {
			return "", ErrCompleteCreateConflict
		}
	}
	restored, err := l.read()
	if err != nil {
		return "", err
	}
	if restored != nil && (restored.Retired || restored.Stage != "invalidated" || restored.PublishedID != "") {
		return "", ErrCompleteCreateConflict
	}
	return "", nil
}

// ReserveCompleteCreate persists ownership before any provisioning can begin.
func (l *TargetLease) ReserveCompleteCreate(owner CompleteCreateOwner) error {
	return l.advanceCompleteCreate(owner, "", CompleteCreateReserved)
}

func (l *TargetLease) BeginCompleteProvisioning(owner CompleteCreateOwner) error {
	return l.advanceCompleteCreate(owner, CompleteCreateReserved, CompleteCreateProvisioning)
}

// FenceCompleteCreate is legal only before provisioning. The caller verifies
// that there is no native Box under this lease before taking this transition.
func (l *TargetLease) FenceCompleteCreate(owner CompleteCreateOwner, prior CompleteCreatePhase) error {
	if prior != "" && prior != CompleteCreateReserved {
		return ErrCompleteCreateConflict
	}
	return l.advanceCompleteCreate(owner, prior, CompleteCreateFenced)
}

// FenceRefusedCompleteCreate follows a definitive pre-effect Runtime refusal.
func (l *TargetLease) FenceRefusedCompleteCreate(owner CompleteCreateOwner) error {
	return l.advanceCompleteCreate(owner, CompleteCreateProvisioning, CompleteCreateUnsupported)
}

func (l *TargetLease) advanceCompleteCreate(owner CompleteCreateOwner, from, to CompleteCreatePhase) error {
	phase, err := l.CompleteCreateState(owner)
	if err != nil {
		return err
	}
	if phase != from {
		return ErrCompleteCreateConflict
	}
	record := completeCreateRecord{Version: 1, Target: l.target, Owner: owner, Phase: to}
	return writeTargetRecord(l.path+".complete-create", record)
}
