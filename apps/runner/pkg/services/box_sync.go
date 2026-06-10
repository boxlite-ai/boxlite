// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package services

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

type BoxSyncServiceConfig struct {
	Logger   *slog.Logger
	Boxlite  *blclient.Client
	Interval time.Duration
}

type BoxSyncService struct {
	log      *slog.Logger
	boxlite  *blclient.Client
	interval time.Duration
	client   *apiclient.APIClient
}

func NewBoxSyncService(config BoxSyncServiceConfig) *BoxSyncService {
	return &BoxSyncService{
		log:      config.Logger.With(slog.String("component", "box_sync_service")),
		boxlite:  config.Boxlite,
		interval: config.Interval,
	}
}

func (s *BoxSyncService) GetLocalContainerStates(ctx context.Context) (map[string]enums.BoxState, error) {
	boxes, err := s.boxlite.ListInfo(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list boxes: %w", err)
	}

	boxStates := make(map[string]enums.BoxState)
	for _, box := range boxes {
		boxId := box.Name
		if boxId == "" {
			boxId = box.ID
		}

		state, err := s.boxlite.GetBoxState(ctx, boxId)
		if err != nil {
			s.log.DebugContext(ctx, "Failed to get state for box", "boxId", boxId, "error", err)
			continue
		}

		boxStates[boxId] = state
	}

	return boxStates, nil
}

func (s *BoxSyncService) GetRemoteBoxStates(ctx context.Context) (map[string]apiclient.BoxState, error) {
	if s.client == nil {
		client, err := runnerapiclient.GetApiClient()
		if err != nil {
			return nil, fmt.Errorf("failed to get API client: %w", err)
		}
		s.client = client
	}
	boxes, _, err := s.client.BoxAPI.GetBoxesForRunner(ctx).
		States(string(apiclient.BOXSTATE_STARTED)).SkipReconcilingBoxes(true).
		Execute()
	if err != nil {
		return nil, fmt.Errorf("failed to get boxes from API: %w", err)
	}

	remoteBoxes := make(map[string]apiclient.BoxState)
	for _, box := range boxes {
		if box.Id != "" {
			remoteBoxes[box.Id] = *box.State
		}
	}

	return remoteBoxes, nil
}

func (s *BoxSyncService) SyncBoxState(ctx context.Context, boxId string, localState enums.BoxState) error {
	_, err := s.client.BoxAPI.UpdateBoxState(ctx, boxId).UpdateBoxStateDto(*apiclient.NewUpdateBoxStateDto(
		string(s.convertToApiState(localState)),
	)).Execute()
	if err != nil {
		return fmt.Errorf("failed to get box %s: %w", boxId, err)
	}

	return nil
}

func (s *BoxSyncService) PerformSync(ctx context.Context) error {
	localStates, err := s.GetLocalContainerStates(ctx)
	if err != nil {
		return fmt.Errorf("failed to get local container states: %w", err)
	}

	remoteStates, err := s.GetRemoteBoxStates(ctx)
	if err != nil {
		return fmt.Errorf("failed to get remote box states: %w", err)
	}

	syncCount := 0
	for boxId, localState := range localStates {
		remoteState, exists := remoteStates[boxId]
		if !exists {
			continue
		}

		convertedRemoteState := s.convertFromApiState(remoteState)

		if localState != convertedRemoteState {
			s.log.InfoContext(ctx, "State mismatch for box", "boxId", boxId, "localState", localState, "remoteState", convertedRemoteState)

			err := s.SyncBoxState(ctx, boxId, localState)
			if err != nil {
				s.log.ErrorContext(ctx, "Failed to sync state for box", "boxId", boxId, "error", err)
				continue
			}
			syncCount++
		}
	}

	if syncCount > 0 {
		s.log.InfoContext(ctx, "Synchronized box states", "syncCount", syncCount)
	}

	return nil
}

func (s *BoxSyncService) StartSyncProcess(ctx context.Context) {
	s.log.InfoContext(ctx, "Starting box sync process")
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
				s.log.InfoContext(ctx, "Box sync service stopped")
				return
			}
		}
	}()
}

func (s *BoxSyncService) convertToApiState(localState enums.BoxState) apiclient.BoxState {
	switch localState {
	case enums.BoxStateCreating:
		return apiclient.BOXSTATE_CREATING
	case enums.BoxStateRestoring:
		return apiclient.BOXSTATE_RESTORING
	case enums.BoxStateDestroyed:
		return apiclient.BOXSTATE_DESTROYED
	case enums.BoxStateDestroying:
		return apiclient.BOXSTATE_DESTROYING
	case enums.BoxStateStarted:
		return apiclient.BOXSTATE_STARTED
	case enums.BoxStateStopped:
		return apiclient.BOXSTATE_STOPPED
	case enums.BoxStateStarting:
		return apiclient.BOXSTATE_STARTING
	case enums.BoxStateStopping:
		return apiclient.BOXSTATE_STOPPING
	case enums.BoxStateError:
		return apiclient.BOXSTATE_ERROR
	default:
		return apiclient.BOXSTATE_UNKNOWN
	}
}

func (s *BoxSyncService) convertFromApiState(apiState apiclient.BoxState) enums.BoxState {
	switch apiState {
	case apiclient.BOXSTATE_CREATING:
		return enums.BoxStateCreating
	case apiclient.BOXSTATE_RESTORING:
		return enums.BoxStateRestoring
	case apiclient.BOXSTATE_DESTROYED:
		return enums.BoxStateDestroyed
	case apiclient.BOXSTATE_DESTROYING:
		return enums.BoxStateDestroying
	case apiclient.BOXSTATE_STARTED:
		return enums.BoxStateStarted
	case apiclient.BOXSTATE_STOPPED:
		return enums.BoxStateStopped
	case apiclient.BOXSTATE_STARTING:
		return enums.BoxStateStarting
	case apiclient.BOXSTATE_STOPPING:
		return enums.BoxStateStopping
	case apiclient.BOXSTATE_ERROR:
		return enums.BoxStateError
	default:
		return enums.BoxStateUnknown
	}
}
