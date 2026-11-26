// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const ProtectedAllocationPrefix = "protected-allocation-"

// ProtectedAllocation records the native instance independent of its boot attempts.
type ProtectedAllocation struct {
	BoxID       string `json:"box_id"`
	AttemptID   string `json:"attempt_id"`
	NativeID    string `json:"native_id,omitempty"`
	CreatorPID  int    `json:"creator_pid"`
	InFlight    bool   `json:"in_flight,omitempty"`
	BootAttempt string `json:"boot_attempt,omitempty"`
	Booted      bool   `json:"booted,omitempty"`
}

func (a ProtectedAllocation) NativeName() string {
	digest := sha256.Sum256([]byte(a.BoxID + "\x00" + a.AttemptID))
	return ProtectedAllocationPrefix + hex.EncodeToString(digest[:16])
}

func validAllocationAttempt(attempt string) bool {
	id, err := uuid.Parse(attempt)
	return err == nil && id != uuid.Nil && id.String() == attempt
}

func allocationDirectory(targetPath string) string {
	return strings.TrimSuffix(targetPath, ".json") + ".allocations"
}

func (l *TargetLease) ProtectedAllocation() (*ProtectedAllocation, error) {
	return readProtectedAllocation(filepath.Join(allocationDirectory(l.path), "current"), l.target)
}

func (o Operations) ProtectedAllocation(target string) (*ProtectedAllocation, error) {
	digest := sha256.Sum256([]byte(target))
	dir := filepath.Join(o.Root, hex.EncodeToString(digest[:])+".allocations")
	return readProtectedAllocation(filepath.Join(dir, "current"), target)
}

func (o Operations) ProtectedAllocationBindings() (map[string]string, error) {
	paths, err := filepath.Glob(filepath.Join(o.Root, "*.allocations", "current"))
	if err != nil {
		return nil, err
	}
	bindings := make(map[string]string)
	for _, path := range paths {
		record, err := readProtectedAllocation(path, "")
		if err != nil {
			return nil, err
		}
		if record != nil && record.NativeID != "" {
			bindings[record.BoxID] = record.NativeID
		}
	}
	return bindings, nil
}

func (l *TargetLease) SaveProtectedAllocation(record ProtectedAllocation) error {
	if record.BoxID != l.target || !validAllocationAttempt(record.AttemptID) || record.CreatorPID < 2 {
		return fmt.Errorf("invalid protected allocation owner")
	}
	dir := allocationDirectory(l.path)
	if err := ensureAllocationDirectory(dir); err != nil {
		return err
	}
	return writeOperationRecord(filepath.Join(dir, "current"), record)
}

// CloseProtectedAllocation is durable before any removal. A delayed allocate
// can never reuse the same attempt, including after a different attempt starts.
func (l *TargetLease) CloseProtectedAllocation(attempt string) error {
	if !validAllocationAttempt(attempt) {
		return fmt.Errorf("invalid protected allocation attempt")
	}
	dir := allocationDirectory(l.path)
	if err := ensureAllocationDirectory(dir); err != nil {
		return err
	}
	return writeOperationRecord(filepath.Join(dir, attempt+".closed"), true)
}

func (l *TargetLease) ProtectedAllocationClosed(attempt string) (bool, error) {
	if !validAllocationAttempt(attempt) {
		return false, fmt.Errorf("invalid protected allocation attempt")
	}
	file, err := regularFile(filepath.Join(allocationDirectory(l.path), attempt+".closed"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, 5))
	if err != nil {
		return false, err
	}
	if string(contents) != "true" {
		return false, fmt.Errorf("invalid closed protected allocation record")
	}
	return true, nil
}

func (l *TargetLease) ClearProtectedAllocation() error {
	dir := allocationDirectory(l.path)
	if err := os.Remove(filepath.Join(dir, "current")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return syncDirectory(dir)
}

func ensureAllocationDirectory(dir string) error {
	if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := privateDirectory(dir); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(dir))
}

func readProtectedAllocation(path, target string) (*ProtectedAllocation, error) {
	file, err := regularFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	document, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return nil, err
	}
	var record ProtectedAllocation
	if len(document) > 4096 || json.Unmarshal(document, &record) != nil || record.BoxID == "" ||
		(target != "" && record.BoxID != target) || !validAllocationAttempt(record.AttemptID) || record.CreatorPID < 2 ||
		(record.BootAttempt != "" && !validAllocationAttempt(record.BootAttempt)) ||
		(record.Booted && (record.BootAttempt == "" || record.NativeID == "")) {
		return nil, fmt.Errorf("invalid protected allocation record")
	}
	return &record, nil
}
