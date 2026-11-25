// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package dto

import boxlite "github.com/boxlite-ai/boxlite/sdks/go"

type CompleteCreateAttempt struct {
	Incarnation string               `json:"incarnation"`
	AttemptID   string               `json:"attempt_id"`
	Generation  uint64               `json:"generation"`
	Prepared    CompleteCreatePolicy `json:"prepared"`
	JobID       string               `json:"job_id,omitempty"`
	ClaimID     string               `json:"claim_id,omitempty"`
}

type CompleteCreatePolicy struct {
	Snapshot    boxlite.CompleteOutboundSnapshot `json:"snapshot"`
	DenyPresent *bool                            `json:"deny_present"`
}

type CompleteCreateRequest struct {
	Attempt CompleteCreateAttempt `json:"attempt"`
	Box     CreateBoxDTO          `json:"box"`
}

type CompleteCreateOutcome string

const (
	CompleteCreatePending   CompleteCreateOutcome = "pending"
	CompleteCreateInstalled CompleteCreateOutcome = "installed"
	CompleteCreateNoEffect  CompleteCreateOutcome = "no_effect"
)

type CompleteCreateResult struct {
	Attempt  CompleteCreateAttempt             `json:"attempt"`
	Outcome  CompleteCreateOutcome             `json:"outcome"`
	Snapshot *boxlite.CompleteOutboundSnapshot `json:"snapshot,omitempty"`
	Failure  string                            `json:"failure,omitempty"`
}
type CompleteRebuildRequest struct {
	Snapshot boxlite.CompleteOutboundSnapshot `json:"snapshot"`
	Stamp    int64                            `json:"stamp"`
	Box      RecoverBoxDTO                    `json:"box"`
}
