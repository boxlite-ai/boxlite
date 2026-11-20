// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import "fmt"

type CompleteRebuild struct {
	Stamp       int64  `json:"stamp"`
	Fingerprint string `json:"fingerprint"`
	PreviousID  string `json:"previous_id"`
	RebuildPin  string `json:"rebuild_pin"`
	CompletedID string `json:"completed_id,omitempty"`
}

// CompleteRebuildFor finds a retry of the current rebuild under its target lease.
func (l *TargetLease) CompleteRebuildFor(stamp int64, fingerprint string) (*CompleteRebuild, error) {
	var record CompleteRebuild
	ok, err := readTargetRecord(l.path+".complete-rebuild", &record)
	if err != nil || !ok {
		return nil, err
	}
	if record.Stamp <= 0 || record.PreviousID == "" || record.Fingerprint == "" || record.RebuildPin == "" {
		return nil, fmt.Errorf("invalid complete rebuild record")
	}
	if stamp < record.Stamp || (stamp == record.Stamp && fingerprint != record.Fingerprint) ||
		(stamp > record.Stamp && record.CompletedID == "") {
		return nil, ErrCompleteCreateConflict
	}
	if stamp > record.Stamp {
		return nil, nil
	}
	return &record, nil
}

func (l *TargetLease) SaveCompleteRebuild(record CompleteRebuild) error {
	return writeTargetRecord(l.path+".complete-rebuild", record)
}
