/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

type StartBoxPayload struct {
	AuthToken *string           `json:"authToken,omitempty"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// MigrateArchivePayload carries the object key of the migration archive. The
// control plane assigns it, so a job redelivered to a restarted runner still
// addresses the object the first delivery used, and the key the control plane
// recorded in box.migrate.arcPath is the key the runner acted on.
type MigrateArchivePayload struct {
	ArcPath string `json:"arcPath"`
}

// MigrateArchiveResult reports the archive the job left in the object store.
type MigrateArchiveResult struct {
	ArcPath string `json:"arcPath"`
}
