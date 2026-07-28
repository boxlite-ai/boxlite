/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

package runtimegeneration

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const maxSafeInteger int64 = 1<<53 - 1

type Registry struct {
	mu                sync.RWMutex
	path              string
	entries           map[string]Entry
	runnerIncarnation int64
}

type Entry struct {
	LastCommandGeneration int64 `json:"lastCommandGeneration"`
	RuntimeGeneration     int64 `json:"runtimeGeneration,omitempty"`
}

type persistedState struct {
	RunnerIncarnation int64            `json:"runnerIncarnation"`
	Entries           map[string]Entry `json:"entries"`
}

func NewRegistry(path string) (*Registry, error) {
	if path == "" {
		return nil, errors.New("runtime generation registry path is required")
	}

	registry := &Registry{
		path:    path,
		entries: make(map[string]Entry),
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return registry, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runtime generation registry: %w", err)
	}
	var state persistedState
	if err := json.Unmarshal(content, &state); err != nil {
		return nil, fmt.Errorf("decode runtime generation registry: %w", err)
	}
	if state.RunnerIncarnation < 0 {
		return nil, fmt.Errorf("decode runtime generation registry: invalid runner incarnation %d", state.RunnerIncarnation)
	}
	registry.runnerIncarnation = state.RunnerIncarnation
	if state.Entries != nil {
		registry.entries = state.Entries
	}
	return registry, nil
}

func (r *Registry) NextRunnerIncarnation() (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.runnerIncarnation >= maxSafeInteger {
		return 0, errors.New("runner incarnation is exhausted")
	}
	r.runnerIncarnation++
	if err := r.persistLocked(); err != nil {
		r.runnerIncarnation--
		return 0, fmt.Errorf("persist runner incarnation: %w", err)
	}
	return r.runnerIncarnation, nil
}

func (r *Registry) Generation(boxID string) int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.entries[boxID].RuntimeGeneration
}

func (r *Registry) LastCommandGeneration(boxID string) int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.entries[boxID].LastCommandGeneration
}

func (r *Registry) ObserveRunning(boxID string) (int64, error) {
	if boxID == "" {
		return 0, errors.New("box ID is required when observing a running runtime")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.entries[boxID]
	if entry.RuntimeGeneration > 0 || entry.LastCommandGeneration <= 0 {
		return entry.RuntimeGeneration, nil
	}
	entry.RuntimeGeneration = entry.LastCommandGeneration
	if err := r.storeLocked(boxID, entry); err != nil {
		return 0, fmt.Errorf("persist observed running generation for box %s: %w", boxID, err)
	}
	return entry.RuntimeGeneration, nil
}

func (r *Registry) PrepareStart(boxID string, generation int64) (bool, error) {
	if boxID == "" || generation <= 0 {
		return false, fmt.Errorf("invalid runtime generation entry for box %q: %d", boxID, generation)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.entries[boxID]
	if generation < entry.LastCommandGeneration {
		return false, nil
	}
	entry.LastCommandGeneration = generation
	entry.RuntimeGeneration = generation
	if err := r.storeLocked(boxID, entry); err != nil {
		return false, fmt.Errorf("persist runtime start generation for box %s: %w", boxID, err)
	}
	return true, nil
}

func (r *Registry) PrepareStop(boxID string, generation, previousGeneration int64) (bool, error) {
	if boxID == "" || generation <= 0 || previousGeneration < 0 || generation <= previousGeneration {
		return false, fmt.Errorf(
			"invalid runtime stop generation entry for box %q: previous=%d current=%d",
			boxID,
			previousGeneration,
			generation,
		)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.entries[boxID]
	if generation < entry.LastCommandGeneration {
		return false, nil
	}
	if generation == entry.LastCommandGeneration && entry.RuntimeGeneration == 0 {
		return false, nil
	}
	entry.LastCommandGeneration = generation
	entry.RuntimeGeneration = generation
	if err := r.storeLocked(boxID, entry); err != nil {
		return false, fmt.Errorf("persist runtime stop generation for box %s: %w", boxID, err)
	}
	return true, nil
}

func (r *Registry) MarkStopped(boxID string, generation int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.entries[boxID]
	if entry.LastCommandGeneration != generation || entry.RuntimeGeneration != generation {
		return nil
	}
	entry.RuntimeGeneration = 0
	if err := r.storeLocked(boxID, entry); err != nil {
		return fmt.Errorf("persist stopped runtime generation for box %s: %w", boxID, err)
	}
	return nil
}

func (r *Registry) storeLocked(boxID string, entry Entry) error {
	previous, existed := r.entries[boxID]
	r.entries[boxID] = entry
	if err := r.persistLocked(); err != nil {
		if existed {
			r.entries[boxID] = previous
		} else {
			delete(r.entries, boxID)
		}
		return err
	}
	return nil
}

func (r *Registry) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o750); err != nil {
		return err
	}
	content, err := json.Marshal(persistedState{
		RunnerIncarnation: r.runnerIncarnation,
		Entries:           r.entries,
	})
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(r.path), ".runtime-generations-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	removeTemp := true
	defer func() {
		if removeTemp {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, r.path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(r.path))
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	if err := directory.Close(); err != nil {
		return err
	}
	removeTemp = false
	return nil
}
