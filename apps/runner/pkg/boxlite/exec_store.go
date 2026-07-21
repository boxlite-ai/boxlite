package boxlite

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ExecRecord is the durable metadata needed to reattach to a still-running
// guest process after a runner restart. It is deliberately minimal: the guest
// owns the process and its output ring, so recovery only needs to know which
// box to attach through, whether the stream is a TTY (gates resize), and when
// the exec was created (preserves the session-lifetime cap across restarts).
type ExecRecord struct {
	ExecID      string `json:"exec_id"`
	BoxID       string `json:"box_id"`
	TTY         bool   `json:"tty"`
	CreatedUnix int64  `json:"created_unix"`
}

// ExecStore persists ExecRecords so ExecManager.Recover can reattach to
// surviving executions after the runner process restarts (e.g. a rolling
// update). Implementations must be safe for concurrent Save/Delete.
type ExecStore interface {
	Save(rec ExecRecord) error
	Delete(execID string) error
	List() ([]ExecRecord, error)
}

// fileExecStore persists one JSON file per exec under dir. Writes are atomic
// (temp file + rename) so a crash mid-write never leaves a half-written record
// that would poison recovery. No external DB dependency — the runner has no
// other persistence and the working set (live execs) is small.
type fileExecStore struct {
	dir string
	mu  sync.Mutex
}

// NewFileExecStore creates the backing directory (0700, exec ids are not
// secrets but the dir sits alongside box state) and returns the store.
func NewFileExecStore(dir string) (*fileExecStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create exec store dir %s: %w", dir, err)
	}
	return &fileExecStore{dir: dir}, nil
}

// isSafeExecID rejects ids that could escape the store directory. Production
// ids are UUIDs, so this only guards against a corrupted/hostile record id
// reaching the filesystem path join.
func isSafeExecID(id string) bool {
	if id == "" || id == "." || id == ".." {
		return false
	}
	return !strings.ContainsAny(id, "/\\") && !strings.Contains(id, "..")
}

func (s *fileExecStore) path(execID string) string {
	return filepath.Join(s.dir, execID+".json")
}

func (s *fileExecStore) Save(rec ExecRecord) error {
	if !isSafeExecID(rec.ExecID) {
		return fmt.Errorf("refusing to persist unsafe exec id %q", rec.ExecID)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal exec record %s: %w", rec.ExecID, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tmp, err := os.CreateTemp(s.dir, rec.ExecID+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp for exec record %s: %w", rec.ExecID, err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("write exec record %s: %w", rec.ExecID, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("close exec record %s: %w", rec.ExecID, err)
	}
	if err := os.Rename(tmpName, s.path(rec.ExecID)); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("commit exec record %s: %w", rec.ExecID, err)
	}
	return nil
}

func (s *fileExecStore) Delete(execID string) error {
	if !isSafeExecID(execID) {
		return fmt.Errorf("refusing to delete unsafe exec id %q", execID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.path(execID)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete exec record %s: %w", execID, err)
	}
	return nil
}

// List returns every persisted record. A record that fails to parse is
// skipped (and logged) rather than aborting recovery of its siblings — one
// corrupt file must not strand every other running exec.
func (s *fileExecStore) List() ([]ExecRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, fmt.Errorf("read exec store dir %s: %w", s.dir, err)
	}
	records := make([]ExecRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		full := filepath.Join(s.dir, entry.Name())
		data, err := os.ReadFile(full)
		if err != nil {
			slog.Warn("boxlite: skipping unreadable exec record", "file", full, "err", err)
			continue
		}
		var rec ExecRecord
		if err := json.Unmarshal(data, &rec); err != nil {
			slog.Warn("boxlite: skipping corrupt exec record", "file", full, "err", err)
			continue
		}
		records = append(records, rec)
	}
	return records, nil
}
