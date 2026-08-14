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
	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// boxStateReader is the slice of the BoxLite client this service needs, kept
// narrow so the sync loop can be exercised without a live runtime.
type boxStateReader interface {
	ListInfo(ctx context.Context) ([]sdkboxlite.BoxInfo, error)
}

type BoxSyncServiceConfig struct {
	Logger   *slog.Logger
	Boxlite  *blclient.Client
	Interval time.Duration
}

type BoxSyncService struct {
	log      *slog.Logger
	boxlite  boxStateReader
	interval time.Duration
	client   *apiclient.APIClient
}

// localContainerState pairs a box's local runtime state with its durable boot
// marker from the same BoxInfo snapshot.
type localContainerState struct {
	state enums.BoxState
	// startedAt is non-nil when BoxLite recorded PID/Running publication for
	// the current or most recently ended lifecycle. It does not prove that the
	// asynchronous Container.Start RPC finished.
	startedAt *time.Time
}

func NewBoxSyncService(config BoxSyncServiceConfig) *BoxSyncService {
	return &BoxSyncService{
		log:      config.Logger.With(slog.String("component", "box_sync_service")),
		boxlite:  config.Boxlite,
		interval: config.Interval,
	}
}

func (s *BoxSyncService) GetLocalContainerStates(ctx context.Context) (map[string]localContainerState, error) {
	boxes, err := s.boxlite.ListInfo(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list boxes: %w", err)
	}

	boxStates := make(map[string]localContainerState, len(boxes))
	for _, box := range boxes {
		boxId := box.Name
		if boxId == "" {
			boxId = box.ID
		}

		boxStates[boxId] = localContainerState{
			state:     blclient.ToBoxState(box.State),
			startedAt: boxStartedAt(box),
		}
	}

	return boxStates, nil
}

// boxStartedAt returns BoxLite's PID/Running publication marker for the current
// or most recently ended lifecycle, or nil when no boot was recorded.
//
// BoxLite publishes the timestamp beside its PID in the same state write. That
// only buys the reader anything while state and timestamp come from one
// snapshot, which is why both are read off the same `BoxInfo`.
func boxStartedAt(box sdkboxlite.BoxInfo) *time.Time {
	if box.StartedAt.IsZero() {
		return nil
	}
	startedAt := box.StartedAt
	return &startedAt
}

func (s *BoxSyncService) GetRemoteBoxStates(ctx context.Context) (map[string]apiclient.BoxState, error) {
	remoteBoxes, err := s.fetchRunnerBoxes(ctx, string(apiclient.BOXSTATE_STARTED), true)
	if err != nil {
		return nil, fmt.Errorf("failed to get boxes from API: %w", err)
	}

	// Boxes the control plane still believes are coming up. Fetching them is
	// what lets the existing mismatch loop below repair a startup whose job
	// completion never landed.
	//
	// An API that predates this query rejects the transitional states with a
	// 400. That must not cost us the STARTED reconciliation above, which has
	// worked on its own for far longer — so the failure degrades to "no
	// candidates this tick" instead of failing the whole sync.
	transitional, err := s.fetchRunnerBoxes(
		ctx,
		string(apiclient.BOXSTATE_CREATING)+","+string(apiclient.BOXSTATE_STARTING),
		false,
	)
	if err != nil {
		s.log.WarnContext(
			ctx,
			"Transitional box query unavailable; skipping start confirmation this cycle",
			"error", err,
		)
		return remoteBoxes, nil
	}
	for boxId, state := range transitional {
		remoteBoxes[boxId] = state
	}

	return remoteBoxes, nil
}

func (s *BoxSyncService) fetchRunnerBoxes(
	ctx context.Context,
	states string,
	skipReconcilingBoxes bool,
) (map[string]apiclient.BoxState, error) {
	if s.client == nil {
		client, err := runnerapiclient.GetApiClient()
		if err != nil {
			return nil, fmt.Errorf("failed to get API client: %w", err)
		}
		s.client = client
	}

	boxes, _, err := s.client.BoxAPI.GetBoxesForRunner(ctx).
		States(states).SkipReconcilingBoxes(skipReconcilingBoxes).
		Execute()
	if err != nil {
		return nil, err
	}

	remoteBoxes := make(map[string]apiclient.BoxState, len(boxes))
	for _, box := range boxes {
		if box.Id != "" && box.State != nil {
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
	for boxId, local := range localStates {
		remoteState, exists := remoteStates[boxId]
		if !exists {
			continue
		}

		convertedRemoteState := s.convertFromApiState(remoteState)

		if local.state != convertedRemoteState {
			if !s.canReport(local, remoteState) {
				continue
			}

			s.log.InfoContext(ctx, "State mismatch for box", "boxId", boxId, "localState", local.state, "remoteState", convertedRemoteState)

			err := s.SyncBoxState(ctx, boxId, local.state)
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

// canReport decides whether this runner may state its local view to the
// control plane for a given remote state.
//
// A box the control plane still shows as coming up is the one case where the
// local view needs durable lifecycle evidence. A transitional box therefore
// requires both local Running and BoxLite's boot marker from the same BoxInfo
// snapshot. The marker confirms PID/Running publication for that lifecycle; it
// intentionally does not confirm the asynchronous Container.Start RPC.
//
// Every other remote state keeps the long-standing behaviour: the local view
// wins unconditionally.
func (s *BoxSyncService) canReport(local localContainerState, remoteState apiclient.BoxState) bool {
	switch remoteState {
	case apiclient.BOXSTATE_CREATING, apiclient.BOXSTATE_STARTING:
		return local.state == enums.BoxStateStarted && local.startedAt != nil
	default:
		return true
	}
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
