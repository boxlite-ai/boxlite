/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner/v2/runtimegeneration"
)

func TestBuildBoxInventoryMapsRuntimeStatesAndUsesControlPlaneIdentity(t *testing.T) {
	boxes := []boxlite.BoxInfo{
		{ID: "runtime-1", Name: "box-1", State: boxlite.StateRunning},
		{ID: "box-2", State: boxlite.StateStopped},
		{ID: "box-3", State: boxlite.StateStopping},
		{ID: "box-4", State: boxlite.StateConfigured},
		{ID: "box-5", State: boxlite.State("unexpected")},
	}

	got, err := buildBoxInventory(boxes, generationMap{"box-1": 9})
	if err != nil {
		t.Fatal(err)
	}
	want := []apiclient.RunnerBoxObservation{
		{BoxId: "box-1", ActualState: apiclient.BOXSTATE_STARTED, RuntimeGeneration: 9},
		{BoxId: "box-2", ActualState: apiclient.BOXSTATE_STOPPED, RuntimeGeneration: 0},
		{BoxId: "box-3", ActualState: apiclient.BOXSTATE_STOPPING, RuntimeGeneration: 0},
		{BoxId: "box-4", ActualState: apiclient.BOXSTATE_CREATING, RuntimeGeneration: 0},
		{BoxId: "box-5", ActualState: apiclient.BOXSTATE_UNKNOWN, RuntimeGeneration: 0},
	}

	if len(got) != len(want) {
		t.Fatalf("inventory length = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].BoxId != want[i].BoxId ||
			got[i].ActualState != want[i].ActualState ||
			got[i].RuntimeGeneration != want[i].RuntimeGeneration {
			t.Errorf("inventory[%d] = %#v, want %#v", i, got[i], want[i])
		}
	}
}

type generationMap map[string]int64

func (m generationMap) Generation(boxID string) int64 {
	return m[boxID]
}

func (m generationMap) ObserveRunning(boxID string) (int64, error) {
	return m[boxID], nil
}

func TestBuildBoxInventoryRestoresAStoppedGenerationWhenTheRuntimeIsRunningAgain(t *testing.T) {
	registry, err := runtimegeneration.NewRegistry(filepath.Join(t.TempDir(), "runtime-generations.json"))
	if err != nil {
		t.Fatal(err)
	}
	if prepared, err := registry.PrepareStart("box-1", 1); err != nil || !prepared {
		t.Fatalf("prepare start = %t, %v; want true, nil", prepared, err)
	}
	if prepared, err := registry.PrepareStop("box-1", 2, 1); err != nil || !prepared {
		t.Fatalf("prepare stop = %t, %v; want true, nil", prepared, err)
	}
	if err := registry.MarkStopped("box-1", 2); err != nil {
		t.Fatal(err)
	}

	inventory, err := buildBoxInventory(
		[]boxlite.BoxInfo{{Name: "box-1", State: boxlite.StateRunning}},
		registry,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := inventory[0].RuntimeGeneration; got != 2 {
		t.Fatalf("running observation generation = %d, want 2", got)
	}
	if got := registry.Generation("box-1"); got != 2 {
		t.Fatalf("restored registry generation = %d, want 2", got)
	}
}

type failingGenerationResolver struct{}

func (failingGenerationResolver) Generation(string) int64 {
	return 0
}

func (failingGenerationResolver) ObserveRunning(string) (int64, error) {
	return 0, errors.New("persist failed")
}

func TestBuildBoxInventoryFailsClosedWhenRunningGenerationCannotBePersisted(t *testing.T) {
	inventory, err := buildBoxInventory(
		[]boxlite.BoxInfo{{Name: "box-1", State: boxlite.StateRunning}},
		failingGenerationResolver{},
	)
	if err == nil {
		t.Fatal("build inventory succeeded despite generation persistence failure")
	}
	if inventory != nil {
		t.Fatalf("inventory = %#v, want nil", inventory)
	}
}

func TestHealthcheckEnvelopeIncludesEpochSequenceAndCompleteEmptyInventory(t *testing.T) {
	healthcheck := apiclient.NewRunnerHealthcheck("epoch-1", 3, 7, "v-test")
	healthcheck.SetBoxes([]apiclient.RunnerBoxObservation{})

	payload, err := json.Marshal(healthcheck)
	if err != nil {
		t.Fatalf("marshal healthcheck: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal healthcheck: %v", err)
	}

	if decoded["runnerEpoch"] != "epoch-1" {
		t.Errorf("runnerEpoch = %#v, want epoch-1", decoded["runnerEpoch"])
	}
	if decoded["runnerIncarnation"] != float64(3) {
		t.Errorf("runnerIncarnation = %#v, want 3", decoded["runnerIncarnation"])
	}
	if decoded["sequence"] != float64(7) {
		t.Errorf("sequence = %#v, want 7", decoded["sequence"])
	}
	boxes, exists := decoded["boxes"]
	if !exists {
		t.Fatal("complete empty inventory must be encoded as boxes: []")
	}
	if got, ok := boxes.([]any); !ok || len(got) != 0 {
		t.Errorf("boxes = %#v, want []", boxes)
	}
}
