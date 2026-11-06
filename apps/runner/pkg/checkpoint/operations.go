// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Operations coordinates checkpoint replacement with ordinary runner lifecycle
// calls. Its key is the public box ID, which survives native ID replacement.
// Lock files remain in place: deleting one could give waiters different inodes.
type Operations struct{ Root string }

type TargetLease struct {
	file   *os.File
	path   string
	target string
}

func (o Operations) Lock(ctx context.Context, target string) (*TargetLease, error) {
	if o.Root == "" || target == "" || len(target) > 128 || strings.ContainsRune(target, 0) {
		return nil, fmt.Errorf("checkpoint operation requires a work directory and valid target")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(o.Root, 0700); err != nil {
		return nil, err
	}
	if err := privateDirectory(o.Root); err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(target))
	key := hex.EncodeToString(digest[:])
	file, err := os.OpenFile(filepath.Join(o.Root, key+".lock"), os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("checkpoint target lock must be a regular file")
	}
	for {
		if err := ctx.Err(); err != nil {
			file.Close()
			return nil, err
		}
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return &TargetLease{file: file, path: filepath.Join(o.Root, key+".json"), target: target}, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func (l *TargetLease) Close() error {
	if l.file == nil {
		return nil
	}
	err := unix.Flock(int(l.file.Fd()), unix.LOCK_UN)
	err = errors.Join(err, l.file.Close())
	l.file = nil
	return err
}

// CheckIdle prevents a failed destructive replacement from being mistaken for
// an ordinary stopped box. Recovery retry or explicit create/destroy owns it.
func (l *TargetLease) CheckIdle() error {
	record, err := l.read()
	if err != nil {
		return err
	}
	if record != nil && record.Stage != "preparing" && record.Stage != "accepted" && record.Stage != "invalidated" {
		return fmt.Errorf("box has unfinished checkpoint operation %s at %s", record.Request.OperationID, record.Stage)
	}
	return nil
}

// Invalidate fences delayed checkpoint deliveries before explicit create or
// destroy has an effect. It leaves a tombstone rather than erasing the sequence.
func (l *TargetLease) Invalidate() error {
	record, err := l.read()
	if err != nil || record == nil {
		return err
	}
	record.Stage = "invalidated"
	return l.write(*record)
}

// Retire fences even a create job that has never reached this runner. Public
// Box IDs are not reused after deletion; migration cleanup uses Invalidate.
func (l *TargetLease) Retire() error {
	return l.write(restoreRecord{Version: 1, Request: RestoreRequest{Target: l.target}, Stage: "invalidated", Retired: true})
}

type restoreRecord struct {
	Retired       bool           `json:"retired,omitempty"`
	Version       int            `json:"version"`
	Request       RestoreRequest `json:"request"`
	Stage         string         `json:"stage"`
	PredecessorID string         `json:"predecessorId,omitempty"`
	AcceptedID    string         `json:"acceptedId,omitempty"`
}

func (l *TargetLease) read() (*restoreRecord, error) {
	file, err := regularFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 64*1024 {
		return nil, fmt.Errorf("checkpoint operation record exceeds 64 KiB")
	}
	var record restoreRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}
	if record.Retired {
		if record.Version != 1 || record.Stage != "invalidated" || record.Request.Target != l.target {
			return nil, fmt.Errorf("invalid retired checkpoint target")
		}
		return &record, nil
	}
	if err := record.Request.validate(); err != nil {
		return nil, err
	}
	switch record.Stage {
	case "preparing", "removing", "importing", "accepted", "invalidated":
	default:
		return nil, fmt.Errorf("unknown checkpoint operation stage %q", record.Stage)
	}
	if record.Version != 1 || record.Request.Target != l.target || (record.Stage == "accepted" && record.AcceptedID == "") {
		return nil, fmt.Errorf("invalid checkpoint operation record")
	}
	return &record, nil
}

func (l *TargetLease) write(record restoreRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(data) > 64*1024 {
		return fmt.Errorf("checkpoint operation record exceeds 64 KiB")
	}
	file, err := os.CreateTemp(filepath.Dir(l.path), ".operation-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	if err := os.Rename(file.Name(), l.path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(l.path))
}
