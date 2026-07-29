/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

type StartBoxPayload struct {
	AuthToken         *string           `json:"authToken,omitempty"`
	Metadata          map[string]string `json:"metadata,omitempty"`
	RuntimeGeneration int64             `json:"runtimeGeneration"`
}

type RuntimeGenerationPayload struct {
	RuntimeGeneration         int64  `json:"runtimeGeneration"`
	PreviousRuntimeGeneration int64  `json:"previousRuntimeGeneration"`
	RunnerEpoch               string `json:"runnerEpoch,omitempty"`
}

type RuntimeStartedResult struct {
	DaemonVersion     string `json:"daemonVersion,omitempty"`
	RunnerEpoch       string `json:"runnerEpoch"`
	RuntimeGeneration int64  `json:"runtimeGeneration"`
}
