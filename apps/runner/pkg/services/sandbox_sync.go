// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package services

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	apiclient "github.com/boxlite-labs/boxlite/libs/api-client-go"
	runnerapiclient "github.com/boxlite-labs/runner/pkg/apiclient"
	blclient "github.com/boxlite-labs/runner/pkg/boxlite"
	"github.com/boxlite-labs/runner/pkg/models/enums"
)

type SandboxSyncServiceConfig struct {
	Logger   *slog.Logger
	Boxlite  *blclient.Client
	Interval time.Duration
}

type SandboxSyncService struct {
	log      *slog.Logger
	boxlite  *blclient.Client
	interval time.Duration
	client   *apiclient.APIClient
}

func NewSandboxSyncService(config SandboxSyncServiceConfig) *SandboxSyncService {
	return &SandboxSyncService{
		log:      config.Logger.With(slog.String("component", "sandbox_sync_service")),
		boxlite:  config.Boxlite,
		interval: config.Interval,
	}
}

func (s *SandboxSyncService) GetLocalContainerStates(ctx context.Context) (map[string]enums.SandboxState, error) {
	boxes, err := s.boxlite.ListInfo(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list boxes: %w", err)
	}

	boxStates := make(map[string]enums.SandboxState)
	for _, box := range boxes {
		sandboxId := box.Name
		if sandboxId == "" {
			sandboxId = box.ID
		}

		state, err := s.boxlite.GetSandboxState(ctx, sandboxId)
		if err != nil {
			s.log.DebugContext(ctx, "Failed to get state for sandbox", "sandboxId", sandboxId, "error", err)
			continue
		}

		boxStates[sandboxId] = state
	}

	return boxStates, nil
}

func (s *SandboxSyncService) GetRemoteSandboxStates(ctx context.Context) (map[string]apiclient.SandboxState, error) {
	if s.client == nil {
		client, err := runnerapiclient.GetApiClient()
		if err != nil {
			return nil, fmt.Errorf("failed to get API client: %w", err)
		}
		s.client = client
	}
	sandboxes, _, err := s.client.SandboxAPI.GetSandboxesForRunner(ctx).
		States(string(apiclient.SANDBOXSTATE_STARTED)).SkipReconcilingSandboxes(true).
		Execute()
	if err != nil {
		return nil, fmt.Errorf("failed to get sandboxes from API: %w", err)
	}

	remoteSandboxes := make(map[string]apiclient.SandboxState)
	for _, sandbox := range sandboxes {
		if sandbox.Id != "" {
			remoteSandboxes[sandbox.Id] = *sandbox.State
		}
	}

	return remoteSandboxes, nil
}

func (s *SandboxSyncService) SyncSandboxState(ctx context.Context, sandboxId string, localState enums.SandboxState) error {
	_, err := s.client.SandboxAPI.UpdateSandboxState(ctx, sandboxId).UpdateSandboxStateDto(*apiclient.NewUpdateSandboxStateDto(
		string(s.convertToApiState(localState)),
	)).Execute()
	if err != nil {
		return fmt.Errorf("failed to get sandbox %s: %w", sandboxId, err)
	}

	return nil
}

func (s *SandboxSyncService) PerformSync(ctx context.Context) error {
	localStates, err := s.GetLocalContainerStates(ctx)
	if err != nil {
		return fmt.Errorf("failed to get local container states: %w", err)
	}

	remoteStates, err := s.GetRemoteSandboxStates(ctx)
	if err != nil {
		return fmt.Errorf("failed to get remote sandbox states: %w", err)
	}

	syncCount := 0
	for sandboxId, localState := range localStates {
		remoteState, exists := remoteStates[sandboxId]
		if !exists {
			continue
		}

		convertedRemoteState := s.convertFromApiState(remoteState)

		if localState != convertedRemoteState {
			s.log.InfoContext(ctx, "State mismatch for sandbox", "sandboxId", sandboxId, "localState", localState, "remoteState", convertedRemoteState)

			err := s.SyncSandboxState(ctx, sandboxId, localState)
			if err != nil {
				s.log.ErrorContext(ctx, "Failed to sync state for sandbox", "sandboxId", sandboxId, "error", err)
				continue
			}
			syncCount++
		}
	}

	if syncCount > 0 {
		s.log.InfoContext(ctx, "Synchronized sandbox states", "syncCount", syncCount)
	}

	return nil
}

func (s *SandboxSyncService) StartSyncProcess(ctx context.Context) {
	s.log.InfoContext(ctx, "Starting sandbox sync process")
	go func() {
		err := s.PerformSync(ctx)
		if err != nil {
			s.log.ErrorContext(ctx, "Failed to perform initial sync", "error", err)
		}

		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				err := s.PerformSync(ctx)
				if err != nil {
					s.log.ErrorContext(ctx, "Failed to perform sync", "error", err)
				}
			case <-ctx.Done():
				s.log.InfoContext(ctx, "Sandbox sync service stopped")
				return
			}
		}
	}()
}

func (s *SandboxSyncService) convertToApiState(localState enums.SandboxState) apiclient.SandboxState {
	switch localState {
	case enums.SandboxStateCreating:
		return apiclient.SANDBOXSTATE_CREATING
	case enums.SandboxStateRestoring:
		return apiclient.SANDBOXSTATE_RESTORING
	case enums.SandboxStateDestroyed:
		return apiclient.SANDBOXSTATE_DESTROYED
	case enums.SandboxStateDestroying:
		return apiclient.SANDBOXSTATE_DESTROYING
	case enums.SandboxStateStarted:
		return apiclient.SANDBOXSTATE_STARTED
	case enums.SandboxStateStopped:
		return apiclient.SANDBOXSTATE_STOPPED
	case enums.SandboxStateStarting:
		return apiclient.SANDBOXSTATE_STARTING
	case enums.SandboxStateStopping:
		return apiclient.SANDBOXSTATE_STOPPING
	case enums.SandboxStateError:
		return apiclient.SANDBOXSTATE_ERROR
	case enums.SandboxStatePullingSnapshot:
		return apiclient.SANDBOXSTATE_PULLING_SNAPSHOT
	default:
		return apiclient.SANDBOXSTATE_UNKNOWN
	}
}

func (s *SandboxSyncService) convertFromApiState(apiState apiclient.SandboxState) enums.SandboxState {
	switch apiState {
	case apiclient.SANDBOXSTATE_CREATING:
		return enums.SandboxStateCreating
	case apiclient.SANDBOXSTATE_RESTORING:
		return enums.SandboxStateRestoring
	case apiclient.SANDBOXSTATE_DESTROYED:
		return enums.SandboxStateDestroyed
	case apiclient.SANDBOXSTATE_DESTROYING:
		return enums.SandboxStateDestroying
	case apiclient.SANDBOXSTATE_STARTED:
		return enums.SandboxStateStarted
	case apiclient.SANDBOXSTATE_STOPPED:
		return enums.SandboxStateStopped
	case apiclient.SANDBOXSTATE_STARTING:
		return enums.SandboxStateStarting
	case apiclient.SANDBOXSTATE_STOPPING:
		return enums.SandboxStateStopping
	case apiclient.SANDBOXSTATE_ERROR:
		return enums.SandboxStateError
	case apiclient.SANDBOXSTATE_PULLING_SNAPSHOT:
		return enums.SandboxStatePullingSnapshot
	default:
		return enums.SandboxStateUnknown
	}
}
