// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

// CheckpointJob is the control plane's durable operation, not a request to
// cold-create a box. Configuration remains inside the verified native pair.
type CheckpointJob struct {
	Kind               string          `json:"kind"`
	BoxID              string          `json:"boxId"`
	OperationID        string          `json:"operationId"`
	CheckpointID       string          `json:"checkpointId"`
	ArchiveURI         string          `json:"archiveUri"`
	NativeCheckpointID string          `json:"nativeCheckpointId,omitempty"`
	ContentSHA256      string          `json:"contentSha256"`
	OrganizationID     string          `json:"organizationId"`
	Configuration      json.RawMessage `json:"configuration,omitempty"`
	CPU                int             `json:"cpu"`
	MemoryMiB          int             `json:"memoryMib"`
}

type CheckpointFailure struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type CheckpointResult struct {
	OperationID     string             `json:"operationId"`
	NativeCompleted bool               `json:"nativeCompleted"`
	State           string             `json:"state"`
	CheckpointID    string             `json:"checkpointId,omitempty"`
	ContentSHA256   string             `json:"contentSha256,omitempty"`
	BootDiskSHA256  string             `json:"bootDiskSha256,omitempty"`
	SizeBytes       int64              `json:"sizeBytes,omitempty"`
	Error           *CheckpointFailure `json:"error,omitempty"`
}

// checkpointNative is the boundary to native work whose completion owns files.
// Every call uses a non-cancelled context; cancellation can stop transfer or
// reporting but must never make cleanup race a late FFI completion.
type checkpointNative interface {
	pause(context.Context, string) error
	resume(context.Context, string) error
	state(context.Context, string) (string, error)
	capture(context.Context, string, string) (*sdk.CheckpointInfo, error)
	exportArchive(context.Context, string, string) error
	importArchive(context.Context, string, string) (*sdk.CheckpointInfo, error)
	restore(context.Context, string, string, string) error
	inspect(string) (*sdk.CloudCheckpointInspection, error)
	register(context.Context, string, sdk.CloudCheckpointImportOptions) (*sdk.CheckpointInfo, error)
	remove(context.Context, string) error
	exportPair(context.Context, string, string) error
}

type checkpointRecord struct {
	Job      CheckpointJob     `json:"job"`
	Result   *CheckpointResult `json:"result,omitempty"`
	NativeID string            `json:"nativeId,omitempty"`
	Started  bool              `json:"started,omitempty"`
}

// CheckpointService shares persistent operation and transfer identities between
// HTTP handlers, v2 jobs and runner restarts. Each identity has one active owner.
type CheckpointService struct {
	root      string
	native    checkpointNative
	store     storage.ArchiveStore
	supported bool
	locks     [3][64]sync.Mutex
	lifecycle sync.RWMutex
	closing   bool
}

func (c *Client) Checkpoints() *CheckpointService {
	c.checkpointOnce.Do(func() {
		supported := runtime.GOOS == "linux" && runtime.GOARCH == "amd64" && c.kernelPath == "" && c.runtime != nil
		if supported {
			f, e := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
			supported = e == nil
			if e == nil {
				_ = f.Close()
			}
		}
		c.checkpointService = &CheckpointService{root: filepath.Join(c.homeDir, "checkpoint-work"), native: sdkCheckpointNative{c}, store: &storage.GCSArchiveStore{}, supported: supported}
	})
	return c.checkpointService
}

func (s *CheckpointService) Enabled(ctx context.Context) bool {
	s.lifecycle.RLock()
	defer s.lifecycle.RUnlock()
	if s.closing {
		return false
	}
	if !s.supported || s.store == nil {
		return false
	}
	if ready, ok := s.store.(interface{ Ready(context.Context) error }); ok {
		return ready.Ready(ctx) == nil
	}
	return true
}

func (s *CheckpointService) beginConsumer() (func(), error) {
	s.lifecycle.RLock()
	if s.closing {
		s.lifecycle.RUnlock()
		return nil, sdk.ErrRuntimeClosed
	}
	return s.lifecycle.RUnlock, nil
}

func checkpointError(code sdk.ErrorCode, message string) error {
	return &sdk.Error{Code: code, Message: message}
}
func canonicalUUID(value string) bool {
	id, e := uuid.Parse(value)
	return e == nil && id.String() == value
}
func validDigest(value string) bool {
	b, e := hex.DecodeString(value)
	return e == nil && len(b) == 32 && hex.EncodeToString(b) == value
}

func (s *CheckpointService) lock(identity string) func() {
	// Separate fixed lock banks avoid unbounded per-operation mutex retention.
	kind, _, _ := strings.Cut(identity, ":")
	bank := 0
	if kind == "transfer" {
		bank = 1
	} else if kind == "box" {
		bank = 2
	}
	digest := sha256.Sum256([]byte(identity))
	lock := &s.locks[bank][int(digest[0])%len(s.locks[bank])]
	lock.Lock()
	return lock.Unlock
}

func writeCheckpointJSON(path string, value any) error {
	data, e := json.Marshal(value)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".record-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}

func (s *CheckpointService) Execute(ctx context.Context, job CheckpointJob) (*CheckpointResult, error) {
	end, err := s.beginConsumer()
	if err != nil {
		return nil, err
	}
	defer end()
	if !canonicalUUID(job.OperationID) || job.BoxID == "" {
		return nil, checkpointError(sdk.ErrInvalidArgument, "operationId UUID and boxId are required")
	}
	if !s.supported {
		return nil, checkpointError(sdk.ErrUnsupported, "memory checkpoints require a supported Linux x86_64 KVM runtime")
	}
	if (job.Kind == "CREATE_CHECKPOINT" || (job.Kind == "IMPORT_CHECKPOINT" && job.NativeCheckpointID == "")) && s.store == nil {
		return nil, checkpointError(sdk.ErrUnsupported, "checkpoint object storage is unavailable")
	}
	unlock := s.lock("operation:" + job.OperationID)
	defer unlock()
	recordPath := filepath.Join(s.root, "operations", job.OperationID+".json")
	record := checkpointRecord{Job: job}
	data, e := os.ReadFile(recordPath)
	if e == nil {
		if e = json.Unmarshal(data, &record); e != nil {
			return nil, checkpointError(sdk.ErrStorage, "invalid checkpoint operation record")
		}
		a, _ := json.Marshal(record.Job)
		b, _ := json.Marshal(job)
		if string(a) != string(b) {
			return nil, checkpointError(sdk.ErrInvalidState, "operationId belongs to different checkpoint work")
		}
		if record.Result != nil {
			if e = s.cleanupOperation(context.WithoutCancel(ctx), recordPath, &record); e != nil {
				record.Result.Error = CheckpointFailureFromError(e)
				return record.Result, e
			}
			return record.Result, checkpointResultError(record.Result)
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	if job.NativeCheckpointID != "" {
		unpin, e := s.pinRegistration(job)
		if e != nil {
			return nil, e
		}
		defer unpin()
	}
	boxUnlock := s.lock("box:" + job.BoxID)
	defer boxUnlock()
	if record.Started && (job.Kind == "PAUSE_BOX" || job.Kind == "RESUME_BOX") {
		state, stateErr := s.native.state(context.WithoutCancel(ctx), job.BoxID)
		if stateErr != nil || state == "" {
			state = "unknown"
		}
		expected := "paused"
		if job.Kind == "RESUME_BOX" {
			expected = "started"
		}
		if stateErr != nil || state != expected {
			err := checkpointError(sdk.ErrInvalidState, "uncertain pause/resume operation cannot be repeated")
			return &CheckpointResult{OperationID: job.OperationID, NativeCompleted: false, State: state, Error: CheckpointFailureFromError(err)}, err
		}
		record.Result = &CheckpointResult{OperationID: job.OperationID, NativeCompleted: true, State: state}
		if err := writeCheckpointJSON(recordPath, &record); err != nil {
			return record.Result, checkpointStorageError(err)
		}
		return record.Result, nil
	}
	record.Started = true
	if e = writeCheckpointJSON(recordPath, &record); e != nil {
		return nil, e
	}
	workDir := filepath.Join(s.root, "operations", job.OperationID)
	if e = os.MkdirAll(workDir, 0700); e != nil {
		return nil, e
	}
	// Native calls finish before run returns, including when ctx is cancelled.
	result := &CheckpointResult{OperationID: job.OperationID, NativeCompleted: true, State: "unknown"}
	e = s.run(ctx, job, &record, recordPath, workDir, result)
	if state, stateErr := s.native.state(context.WithoutCancel(ctx), job.BoxID); stateErr == nil {
		result.State = state
	}
	if e != nil {
		result.Error = CheckpointFailureFromError(e)
	}
	record.Result = result
	if saveErr := writeCheckpointJSON(recordPath, &record); saveErr != nil {
		result.Error = CheckpointFailureFromError(checkpointStorageError(saveErr))
		return result, saveErr
	}
	if cleanErr := s.cleanupOperation(context.WithoutCancel(ctx), recordPath, &record); cleanErr != nil {
		result.Error = CheckpointFailureFromError(checkpointStorageError(cleanErr))
		return result, cleanErr
	}
	return result, e
}

func (s *CheckpointService) cleanupOperation(ctx context.Context, path string, record *checkpointRecord) error {
	if record.NativeID != "" {
		if err := s.native.remove(ctx, record.NativeID); err != nil && !sdk.IsNotFound(err) {
			return err
		}
		record.NativeID = ""
		if err := writeCheckpointJSON(path, record); err != nil {
			return checkpointStorageError(err)
		}
	}
	return checkpointStorageError(os.RemoveAll(filepath.Join(s.root, "operations", record.Job.OperationID)))
}

func (s *CheckpointService) run(ctx context.Context, job CheckpointJob, record *checkpointRecord, recordPath, workDir string, result *CheckpointResult) error {
	nativeCtx := context.WithoutCancel(ctx)
	switch job.Kind {
	case "PAUSE_BOX":
		return s.native.pause(nativeCtx, job.BoxID)
	case "RESUME_BOX":
		return s.native.resume(nativeCtx, job.BoxID)
	case "CREATE_CHECKPOINT":
		if !canonicalUUID(job.CheckpointID) || !validCheckpointURI(job.ArchiveURI, "") {
			return checkpointError(sdk.ErrInvalidArgument, "checkpoint ID and archive URI are required")
		}
		if record.NativeID == "" {
			info, e := s.native.capture(nativeCtx, job.BoxID, "cloud-"+job.OperationID)
			if e != nil {
				return e
			}
			record.NativeID = info.Id
			if e = writeCheckpointJSON(recordPath, record); e != nil {
				return e
			}
		}
		archive := filepath.Join(workDir, "checkpoint.tar.zst")
		if _, e := os.Stat(archive); errors.Is(e, os.ErrNotExist) {
			if e = s.native.exportArchive(nativeCtx, record.NativeID, archive); e != nil {
				return e
			}
		}
		stat, e := os.Stat(archive)
		if e != nil {
			return e
		}
		manifest, e := checkpointArchiveIdentity(archive)
		if e != nil {
			return e
		}
		if e = s.store.Upload(ctx, job.ArchiveURI, archive); e != nil {
			return checkpointStorageError(e)
		}
		result.CheckpointID = job.CheckpointID
		result.ContentSHA256 = manifest.MetadataSHA256
		result.BootDiskSHA256 = manifest.Members["boot.raw"].SHA256
		result.SizeBytes = stat.Size()
		return nil
	case "IMPORT_CHECKPOINT":
		if !canonicalUUID(job.CheckpointID) || !canonicalUUID(job.OrganizationID) || !validDigest(job.ContentSHA256) {
			return checkpointError(sdk.ErrInvalidArgument, "invalid checkpoint restore identity")
		}
		nativeID := job.NativeCheckpointID
		if nativeID == "" {
			if !validCheckpointURI(job.ArchiveURI, job.OrganizationID) {
				return checkpointError(sdk.ErrInvalidArgument, "archive does not belong to the checkpoint organization")
			}
			archive := filepath.Join(workDir, "checkpoint.tar.zst")
			if e := s.store.Download(ctx, job.ArchiveURI, archive); e != nil {
				return checkpointStorageError(e)
			}
			manifest, e := checkpointArchiveIdentity(archive)
			if e != nil {
				return e
			}
			if manifest.MetadataSHA256 != job.ContentSHA256 {
				return checkpointError(sdk.ErrStorage, "managed checkpoint metadata identity mismatch")
			}
			record.NativeID = job.OperationID
			if e = writeCheckpointJSON(recordPath, record); e != nil {
				return e
			}
			info, e := s.native.importArchive(nativeCtx, archive, job.OperationID)
			if e != nil {
				return e
			}
			record.NativeID = info.Id
			if e = writeCheckpointJSON(recordPath, record); e != nil {
				return e
			}
			if int(info.CPUs) != job.CPU || info.MemoryBytes != uint64(job.MemoryMiB)*1024*1024 {
				return checkpointError(sdk.ErrInvalidState, "checkpoint allocation differs from admitted allocation")
			}
			nativeID = info.Id
		} else if !canonicalUUID(nativeID) {
			return checkpointError(sdk.ErrInvalidArgument, "invalid native checkpoint ID")
		}
		return s.native.restore(nativeCtx, nativeID, job.BoxID, job.OperationID)
	default:
		return checkpointError(sdk.ErrInvalidArgument, "unknown checkpoint operation")
	}
}

// CheckpointFailureFromError preserves the native error envelope in job
// metadata, which is also used when no operation was accepted.
func CheckpointFailureFromError(err error) *CheckpointFailure {
	code := sdk.ErrInternal
	message := err.Error()
	var native *sdk.Error
	if errors.As(err, &native) {
		code = native.Code
		message = native.Message
	}
	switch code {
	case sdk.ErrNotFound:
		return &CheckpointFailure{"NotFoundError", "not_found", message}
	case sdk.ErrAlreadyExists:
		return &CheckpointFailure{"AlreadyExistsError", "already_exists", message}
	case sdk.ErrInvalidArgument:
		return &CheckpointFailure{"InvalidArgumentError", "invalid_argument", message}
	case sdk.ErrUnsupported:
		return &CheckpointFailure{"UnsupportedError", "unsupported", message}
	case sdk.ErrInvalidState:
		return &CheckpointFailure{"InvalidStateError", "invalid_state", message}
	case sdk.ErrStorage:
		return &CheckpointFailure{"StorageError", "storage_error", message}
	case sdk.ErrDatabase:
		return &CheckpointFailure{"DatabaseError", "database_error", message}
	case sdk.ErrConfig:
		return &CheckpointFailure{"ConfigError", "config_error", message}
	case sdk.ErrImage:
		return &CheckpointFailure{"ImageError", "image_pull_failed", message}
	case sdk.ErrNetwork:
		return &CheckpointFailure{"NetworkError", "network_unavailable", message}
	case sdk.ErrExecution:
		return &CheckpointFailure{"ExecutionError", "execution_failed", message}
	case sdk.ErrStopped:
		return &CheckpointFailure{"StoppedError", "stopped", message}
	case sdk.ErrEngine:
		return &CheckpointFailure{"EngineError", "engine_unavailable", message}
	case sdk.ErrPortal, sdk.ErrRpc, sdk.ErrRpcTransport:
		return &CheckpointFailure{"UpstreamUnavailableError", "upstream_unavailable", message}
	case sdk.ErrMetadata:
		return &CheckpointFailure{"MetadataError", "metadata_error", message}
	case sdk.ErrUnsupportedEngine:
		return &CheckpointFailure{"UnsupportedError", "unsupported", message}
	case sdk.ErrResourceExhausted:
		return &CheckpointFailure{"ResourceExhaustedError", "resource_exhausted", message}
	case sdk.ErrSessionReaped:
		return &CheckpointFailure{"SessionReapedError", "session_reaped", message}
	default:
		return &CheckpointFailure{"InternalError", "internal", message}
	}
}

func checkpointResultError(result *CheckpointResult) error {
	if result.Error == nil {
		return nil
	}
	codes := map[string]sdk.ErrorCode{"invalid_argument": sdk.ErrInvalidArgument, "unsupported": sdk.ErrUnsupported, "invalid_state": sdk.ErrInvalidState, "storage_error": sdk.ErrStorage, "database_error": sdk.ErrDatabase, "not_found": sdk.ErrNotFound, "already_exists": sdk.ErrAlreadyExists, "config_error": sdk.ErrConfig, "image_pull_failed": sdk.ErrImage, "network_unavailable": sdk.ErrNetwork, "execution_failed": sdk.ErrExecution, "stopped": sdk.ErrStopped, "engine_unavailable": sdk.ErrEngine, "upstream_unavailable": sdk.ErrRpcTransport, "metadata_error": sdk.ErrMetadata, "resource_exhausted": sdk.ErrResourceExhausted, "session_reaped": sdk.ErrSessionReaped}
	code, ok := codes[result.Error.Code]
	if !ok {
		code = sdk.ErrInternal
	}
	return checkpointError(code, result.Error.Message)
}

type sdkCheckpointNative struct{ client *Client }

func (n sdkCheckpointNative) pause(ctx context.Context, id string) error {
	b, e := n.client.getOrFetchBox(ctx, id)
	if e != nil {
		return e
	}
	return b.Pause(ctx, sdk.PauseOptions{})
}
func (n sdkCheckpointNative) resume(ctx context.Context, id string) error {
	b, e := n.client.getOrFetchBox(ctx, id)
	if e != nil {
		return e
	}
	return b.Resume(ctx)
}
func (n sdkCheckpointNative) state(ctx context.Context, id string) (string, error) {
	info, e := n.client.runtime.GetInfo(ctx, id)
	if e != nil {
		return "unknown", e
	}
	switch info.State {
	case sdk.StatePaused:
		return "paused", nil
	case sdk.StateRunning:
		return "started", nil
	default:
		return "unknown", nil
	}
}
func (n sdkCheckpointNative) capture(ctx context.Context, id, name string) (*sdk.CheckpointInfo, error) {
	b, e := n.client.getOrFetchBox(ctx, id)
	if e != nil {
		return nil, e
	}
	c, e := b.Checkpoints()
	if e != nil {
		return nil, e
	}
	defer c.Close()
	if info, e := c.Get(ctx, name); e != nil {
		return nil, e
	} else if info != nil {
		if info.BoxId != b.ID() || info.Status != "ready" {
			return nil, checkpointError(sdk.ErrInvalidState, "checkpoint operation identity is not ready")
		}
		return info, nil
	}
	return c.Create(ctx, name)
}
func (n sdkCheckpointNative) exportArchive(ctx context.Context, id, path string) error {
	return n.client.runtime.ExportCheckpointArchive(ctx, id, path)
}
func (n sdkCheckpointNative) importArchive(ctx context.Context, path, op string) (*sdk.CheckpointInfo, error) {
	return n.client.runtime.ImportCheckpointArchive(ctx, path, op)
}
func (n sdkCheckpointNative) restore(ctx context.Context, id, name, op string) error {
	b, e := n.client.runtime.CreateFromCheckpointWithOperation(ctx, id, name, op)
	if e != nil {
		return e
	}
	n.client.mu.Lock()
	defer n.client.mu.Unlock()
	if old := n.client.boxes[name]; old != nil && old != b {
		_ = old.Close()
	}
	n.client.boxes[name] = b
	return nil
}
func (n sdkCheckpointNative) inspect(path string) (*sdk.CloudCheckpointInspection, error) {
	return sdk.InspectCloudUpload(path)
}
func (n sdkCheckpointNative) register(ctx context.Context, path string, options sdk.CloudCheckpointImportOptions) (*sdk.CheckpointInfo, error) {
	return n.client.runtime.ImportCheckpointPair(ctx, path, options)
}
func (n sdkCheckpointNative) remove(ctx context.Context, id string) error {
	c, e := n.client.runtime.Checkpoints()
	if e != nil {
		return e
	}
	defer c.Close()
	return c.Remove(ctx, id, true)
}
func (n sdkCheckpointNative) exportPair(ctx context.Context, id, path string) error {
	b, e := n.client.getOrFetchBox(ctx, id)
	if e != nil {
		return e
	}
	return b.ExportCheckpoint(ctx, path)
}

func (c *Client) ExecuteCheckpoint(ctx context.Context, job CheckpointJob) (*CheckpointResult, error) {
	return c.Checkpoints().Execute(ctx, job)
}
