/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

package runtimegeneration

import (
	"path/filepath"
	"testing"
)

func TestRegistryPersistsMonotonicCommandFenceAndStoppedTombstone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-generations.json")
	registry, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if prepared, err := registry.PrepareStart("box-1", 7); err != nil || !prepared {
		t.Fatalf("prepare start = %t, %v; want true, nil", prepared, err)
	}
	if prepared, err := registry.PrepareStart("box-1", 6); err != nil || prepared {
		t.Fatalf("stale prepare start = %t, %v; want false, nil", prepared, err)
	}
	if prepared, err := registry.PrepareStop("box-1", 8, 7); err != nil || !prepared {
		t.Fatalf("prepare stop = %t, %v; want true, nil", prepared, err)
	}
	if err := registry.MarkStopped("box-1", 8); err != nil {
		t.Fatal(err)
	}
	if prepared, err := registry.PrepareStart("box-1", 7); err != nil || prepared {
		t.Fatalf("late start after stop = %t, %v; want false, nil", prepared, err)
	}

	reloaded, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Generation("box-1"); got != 0 {
		t.Fatalf("runtime generation = %d, want 0", got)
	}
	if got := reloaded.LastCommandGeneration("box-1"); got != 8 {
		t.Fatalf("last command generation = %d, want 8", got)
	}
}

func TestRegistryPersistsMonotonicRunnerIncarnation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-generations.json")
	first, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	firstIncarnation, err := first.NextRunnerIncarnation()
	if err != nil {
		t.Fatal(err)
	}
	if firstIncarnation != 1 {
		t.Fatalf("first runner incarnation = %d, want 1", firstIncarnation)
	}

	reloaded, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	secondIncarnation, err := reloaded.NextRunnerIncarnation()
	if err != nil {
		t.Fatal(err)
	}
	if secondIncarnation != 2 {
		t.Fatalf("second runner incarnation = %d, want 2", secondIncarnation)
	}
}

func TestRegistryRestoresTheCommandHighWaterMarkWhenAStoppedRuntimeIsObservedRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime-generations.json")
	registry, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if prepared, err := registry.PrepareStart("box-1", 7); err != nil || !prepared {
		t.Fatalf("prepare start = %t, %v; want true, nil", prepared, err)
	}
	if prepared, err := registry.PrepareStop("box-1", 8, 7); err != nil || !prepared {
		t.Fatalf("prepare stop = %t, %v; want true, nil", prepared, err)
	}
	if err := registry.MarkStopped("box-1", 8); err != nil {
		t.Fatal(err)
	}

	generation, err := registry.ObserveRunning("box-1")
	if err != nil {
		t.Fatal(err)
	}
	if generation != 8 {
		t.Fatalf("observed running generation = %d, want 8", generation)
	}

	reloaded, err := NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Generation("box-1"); got != 8 {
		t.Fatalf("persisted runtime generation = %d, want 8", got)
	}
}
