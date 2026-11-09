// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/klauspost/compress/zstd"
)

const checkpointTestOperation = "11111111-1111-4111-8111-111111111111"
const checkpointTestOrganization = "22222222-2222-4222-8222-222222222222"
const checkpointTestResource = "33333333-3333-4333-8333-333333333333"
const checkpointTestNative = "44444444-4444-4444-8444-444444444444"
const checkpointTestBox = "55555555-5555-4555-8555-555555555555"

type checkpointNativeFixture struct {
	mu         sync.Mutex
	calls      []string
	current    string
	block      <-chan struct{}
	entered    chan struct{}
	inspection sdk.CloudCheckpointInspection
	restoreErr error
	removeErr  error
}

func (n *checkpointNativeFixture) record(call string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, call)
}
func (n *checkpointNativeFixture) pause(ctx context.Context, id string) error {
	n.record("pause")
	if n.entered != nil {
		close(n.entered)
	}
	if n.block != nil {
		select {
		case <-n.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	n.current = "paused"
	return nil
}
func (n *checkpointNativeFixture) resume(context.Context, string) error {
	n.record("resume")
	n.current = "started"
	return nil
}
func (n *checkpointNativeFixture) state(context.Context, string) (string, error) {
	return n.current, nil
}
func (n *checkpointNativeFixture) capture(context.Context, string, string) (*sdk.CheckpointInfo, error) {
	n.record("capture")
	return &sdk.CheckpointInfo{Id: checkpointTestNative}, nil
}
func (n *checkpointNativeFixture) exportArchive(_ context.Context, id, path string) error {
	n.record("export-archive")
	return writeCheckpointArchiveFixture(path)
}
func (n *checkpointNativeFixture) importArchive(_ context.Context, _ string, operation string) (*sdk.CheckpointInfo, error) {
	n.record("import-archive")
	return &sdk.CheckpointInfo{Id: operation, CPUs: 2, MemoryBytes: 1024 << 20}, nil
}
func (n *checkpointNativeFixture) restore(ctx context.Context, id, name, op string) error {
	n.record("restore")
	if n.entered != nil {
		close(n.entered)
	}
	if n.block != nil {
		select {
		case <-n.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	n.current = "paused"
	return n.restoreErr
}
func (n *checkpointNativeFixture) inspect(path string) (*sdk.CloudCheckpointInspection, error) {
	n.record("inspect")
	if _, e := os.Stat(filepath.Join(path, "snapshot.mem")); e != nil {
		return nil, e
	}
	return &n.inspection, nil
}
func (n *checkpointNativeFixture) register(ctx context.Context, path string, options sdk.CloudCheckpointImportOptions) (*sdk.CheckpointInfo, error) {
	n.record("register")
	if options.ExpectedPairSHA256 != n.inspection.PairSHA256 {
		return nil, checkpointError(sdk.ErrInvalidArgument, "digest changed")
	}
	return &sdk.CheckpointInfo{Id: options.OperationID}, nil
}
func (n *checkpointNativeFixture) remove(context.Context, string) error {
	n.record("remove")
	return n.removeErr
}
func (n *checkpointNativeFixture) exportPair(_ context.Context, id, path string) error {
	n.record("export-pair")
	if e := os.Mkdir(path, 0700); e != nil {
		return e
	}
	if e := os.WriteFile(filepath.Join(path, "snapshot.mem"), []byte("memory"), 0600); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(path, "snapshot.qcow2"), []byte("disk"), 0600)
}

type checkpointStoreFixture struct {
	files     map[string][]byte
	uploads   int
	uploadErr error
}

func (s *checkpointStoreFixture) Upload(_ context.Context, key, path string) error {
	s.uploads++
	if s.uploadErr != nil {
		return s.uploadErr
	}
	data, e := os.ReadFile(path)
	if s.files == nil {
		s.files = map[string][]byte{}
	}
	s.files[key] = data
	return e
}
func (s *checkpointStoreFixture) Download(_ context.Context, key, path string) error {
	data, ok := s.files[key]
	if !ok {
		return checkpointError(sdk.ErrStorage, "object missing")
	}
	return os.WriteFile(path, data, 0600)
}
func (s *checkpointStoreFixture) Remove(context.Context, string) error { return nil }

func newCheckpointFixture(t *testing.T) (*CheckpointService, *checkpointNativeFixture, *checkpointStoreFixture) {
	t.Helper()
	native := &checkpointNativeFixture{current: "paused", inspection: sdk.CloudCheckpointInspection{Version: 1, PairSHA256: strings.Repeat("a", 64), BootDiskSHA256: strings.Repeat("b", 64), Resources: sdk.CloudCheckpointResources{CPUs: 2, MemoryMiB: 1024}}}
	store := &checkpointStoreFixture{}
	return &CheckpointService{root: t.TempDir(), native: native, store: store, supported: true}, native, store
}

func writeCheckpointArchiveFixture(path string) error {
	file, e := os.Create(path)
	if e != nil {
		return e
	}
	defer file.Close()
	encoder, e := zstd.NewWriter(file)
	if e != nil {
		return e
	}
	archive := tar.NewWriter(encoder)
	digest := sha256.Sum256([]byte("boot"))
	manifest := checkpointArchiveManifest{Version: 2, MetadataSHA256: strings.Repeat("c", 64), Members: map[string]struct {
		Length int64  `json:"length"`
		SHA256 string `json:"sha256"`
	}{"boot.raw": {4, hex.EncodeToString(digest[:])}}}
	body, _ := json.Marshal(manifest)
	for _, member := range []struct {
		name string
		body []byte
	}{{"manifest.json", body}, {"boot.raw", []byte("boot")}} {
		if e = archive.WriteHeader(&tar.Header{Name: member.name, Mode: 0600, Size: int64(len(member.body)), Typeflag: tar.TypeReg}); e != nil {
			return e
		}
		if _, e = archive.Write(member.body); e != nil {
			return e
		}
	}
	if e = archive.Close(); e != nil {
		return e
	}
	return encoder.Close()
}

func TestCheckpointJobReplayUsesPersistedIdentity(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	job := CheckpointJob{Kind: "PAUSE_BOX", BoxID: checkpointTestBox, OperationID: checkpointTestOperation}
	first, e := service.Execute(context.Background(), job)
	if e != nil || !first.NativeCompleted || first.State != "paused" {
		t.Fatalf("pause result=%+v err=%v", first, e)
	}
	// Reconstructing the facade simulates a runner process restart, not an
	// in-memory return-value cache. A late pause cannot freeze a resumed box.
	service = &CheckpointService{root: service.root, native: native, supported: true}
	native.current = "started"
	second, e := service.Execute(context.Background(), job)
	if e != nil || second.State != "paused" {
		t.Fatalf("replay=%+v %v", second, e)
	}
	if len(native.calls) != 1 {
		t.Fatalf("replay repeated native operation: %v", native.calls)
	}
	job.BoxID = checkpointTestResource
	if _, e = service.Execute(context.Background(), job); !sdk.IsInvalidState(e) {
		t.Fatalf("operation identity reused: %v", e)
	}
}

func TestCheckpointCancellationWaitsForNativeCompletion(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	release := make(chan struct{})
	native.block = release
	native.entered = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, e := service.Execute(ctx, CheckpointJob{Kind: "PAUSE_BOX", BoxID: checkpointTestBox, OperationID: checkpointTestOperation})
		done <- e
	}()
	<-native.entered
	cancel()
	select {
	case e := <-done:
		t.Fatalf("returned before native completion: %v", e)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native completion not observed")
	}
}

func TestCheckpointRuntimeCloseWaitsForFileConsumer(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	release := make(chan struct{})
	native.block = release
	native.entered = make(chan struct{})
	runtime, e := sdk.NewRest(sdk.BoxliteRestOptions{URL: "http://127.0.0.1:1"})
	if e != nil {
		t.Fatal(e)
	}
	client := &Client{runtime: runtime, checkpointService: service}
	client.checkpointOnce.Do(func() {})
	finished := make(chan error, 1)
	go func() {
		_, e := service.Execute(context.Background(), CheckpointJob{Kind: "PAUSE_BOX", BoxID: checkpointTestBox, OperationID: checkpointTestOperation})
		finished <- e
	}()
	<-native.entered
	closed := make(chan error, 1)
	go func() { closed <- client.Close() }()
	select {
	case e := <-closed:
		t.Fatalf("runtime closed before native completion: %v", e)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if e := <-finished; e != nil {
		t.Fatal(e)
	}
	if e := <-closed; e != nil {
		t.Fatal(e)
	}
	if _, e := service.Execute(context.Background(), CheckpointJob{Kind: "RESUME_BOX", BoxID: checkpointTestBox, OperationID: checkpointTestResource}); !sdk.IsInvalidState(e) {
		t.Fatalf("closed service accepted native work: %v", e)
	}
}

func TestCheckpointUncertainPauseNeverRepeatsEffect(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	job := CheckpointJob{Kind: "PAUSE_BOX", BoxID: checkpointTestBox, OperationID: checkpointTestOperation}
	if _, e := service.Execute(context.Background(), job); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(service.root, "operations", job.OperationID+".json")
	data, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var record checkpointRecord
	if e = json.Unmarshal(data, &record); e != nil {
		t.Fatal(e)
	}
	record.Result = nil
	if e = writeCheckpointJSON(path, &record); e != nil {
		t.Fatal(e)
	}
	native.current = "started"
	result, e := service.Execute(context.Background(), job)
	if !sdk.IsInvalidState(e) || result.NativeCompleted || len(native.calls) != 1 {
		t.Fatalf("uncertain pause repeated or acknowledged: %+v %v calls=%v", result, e, native.calls)
	}
	native.current = "paused"
	result, e = service.Execute(context.Background(), job)
	if e != nil || !result.NativeCompleted || len(native.calls) != 1 {
		t.Fatalf("confirmed pause not reconciled: %+v %v", result, e)
	}
}

func TestCheckpointCaptureUploadsOnlyCompleteArchive(t *testing.T) {
	service, native, store := newCheckpointFixture(t)
	uri := "gs://bucket/checkpoints/" + checkpointTestOrganization + "/" + checkpointTestResource + ".checkpoint"
	result, e := service.Execute(context.Background(), CheckpointJob{Kind: "CREATE_CHECKPOINT", BoxID: checkpointTestBox, OperationID: checkpointTestOperation, CheckpointID: checkpointTestResource, ArchiveURI: uri})
	if e != nil {
		t.Fatal(e)
	}
	archive, ok := store.files[uri]
	if !ok || result.SizeBytes != int64(len(archive)) {
		t.Fatalf("missing or incomplete object: %+v", result)
	}
	path := filepath.Join(t.TempDir(), "uploaded.zst")
	if e = os.WriteFile(path, archive, 0600); e != nil {
		t.Fatal(e)
	}
	manifest, e := checkpointArchiveIdentity(path)
	if e != nil || result.ContentSHA256 != manifest.MetadataSHA256 {
		t.Fatal("result does not bind uploaded metadata")
	}
	if !strings.Contains(strings.Join(native.calls, ","), "export-archive,remove") {
		t.Fatalf("native resource not released: %v", native.calls)
	}
	if _, e = os.Stat(filepath.Join(service.root, "operations", checkpointTestOperation)); !errors.Is(e, os.ErrNotExist) {
		t.Fatalf("work files remain: %v", e)
	}
}

func TestCheckpointFailedUploadIsNotPublishedOrRepeated(t *testing.T) {
	service, native, store := newCheckpointFixture(t)
	store.uploadErr = checkpointError(sdk.ErrStorage, "storage offline")
	job := CheckpointJob{Kind: "CREATE_CHECKPOINT", BoxID: checkpointTestBox, OperationID: checkpointTestOperation, CheckpointID: checkpointTestResource, ArchiveURI: "gs://bucket/checkpoints/resource"}
	result, e := service.Execute(context.Background(), job)
	if e == nil || result.Error.Code != "storage_error" || !result.NativeCompleted {
		t.Fatalf("failure=%+v %v", result, e)
	}
	if _, e = service.Execute(context.Background(), job); e == nil || store.uploads != 1 {
		t.Fatalf("failed replay repeated upload: %v %d", e, store.uploads)
	}
	if native.calls[len(native.calls)-1] != "remove" {
		t.Fatalf("failed work leaked native resource: %v", native.calls)
	}
}

func TestCheckpointManagedRestoreBindsMetadataBeforeCreatingBox(t *testing.T) {
	for _, valid := range []bool{true, false} {
		t.Run(map[bool]string{true: "matching metadata", false: "different metadata identity"}[valid], func(t *testing.T) {
			service, native, store := newCheckpointFixture(t)
			path := filepath.Join(t.TempDir(), "source.checkpoint")
			if e := writeCheckpointArchiveFixture(path); e != nil {
				t.Fatal(e)
			}
			data, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			manifest, e := checkpointArchiveIdentity(path)
			if e != nil {
				t.Fatal(e)
			}
			uri := "gs://bucket/checkpoints/" + checkpointTestOrganization + "/saved.checkpoint"
			store.files = map[string][]byte{uri: data}
			job := CheckpointJob{Kind: "IMPORT_CHECKPOINT", BoxID: checkpointTestBox, OperationID: checkpointTestOperation, CheckpointID: checkpointTestResource, ArchiveURI: uri, ContentSHA256: manifest.MetadataSHA256, OrganizationID: checkpointTestOrganization, CPU: 2, MemoryMiB: 1024}
			if !valid {
				job.ContentSHA256 = strings.Repeat("f", 64)
			}
			result, e := service.Execute(context.Background(), job)
			if valid {
				if e != nil || !result.NativeCompleted || result.State != "paused" {
					t.Fatalf("restore=%+v %v", result, e)
				}
				if strings.Join(native.calls, ",") != "import-archive,restore,remove" {
					t.Fatalf("restore order=%v", native.calls)
				}
			} else {
				if e == nil || result.Error.Code != "storage_error" || len(native.calls) != 0 {
					t.Fatalf("different checkpoint reached native: %+v %v calls=%v", result, e, native.calls)
				}
			}
		})
	}
}

func TestCheckpointCloudArchiveRequiresMetadataIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "archive.zst")
	if e := writeCheckpointArchiveFixture(path); e != nil {
		t.Fatal(e)
	}
	encoded, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	decoder, e := zstd.NewReader(nil)
	if e != nil {
		t.Fatal(e)
	}
	defer decoder.Close()
	raw, e := decoder.DecodeAll(encoded, nil)
	if e != nil {
		t.Fatal(e)
	}
	raw = bytes.Replace(raw, []byte(`"version":2`), []byte(`"version":1`), 1)
	encoder, e := zstd.NewWriter(nil)
	if e != nil {
		t.Fatal(e)
	}
	defer encoder.Close()
	if e = os.WriteFile(path, encoder.EncodeAll(raw, nil), 0600); e != nil {
		t.Fatal(e)
	}
	_, e = checkpointArchiveIdentity(path)
	var native *sdk.Error
	if !errors.As(e, &native) || native.Code != sdk.ErrUnsupported {
		t.Fatalf("legacy archive: %v", e)
	}
}

func TestCheckpointPairTransferIgnoresContentChecksum(t *testing.T) {
	data := pairTransferFixture(t, []string{"snapshot.mem", "snapshot.qcow2"})
	data[len(data)-1] ^= 1
	path := filepath.Join(t.TempDir(), "pair")
	if e := unpackCheckpointPair(bytes.NewReader(data), path); e != nil {
		t.Fatal(e)
	}
	content, e := os.ReadFile(filepath.Join(path, "snapshot.mem"))
	if e != nil || string(content) != "body" {
		t.Fatalf("payload: %q %v", content, e)
	}
}

func pairTransferFixture(t *testing.T, members []string) []byte {
	t.Helper()
	var output bytes.Buffer
	encoder, e := zstd.NewWriter(&output)
	if e != nil {
		t.Fatal(e)
	}
	archive := tar.NewWriter(encoder)
	for _, name := range members {
		if e = archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: 4, Typeflag: tar.TypeReg, Format: tar.FormatUSTAR}); e != nil {
			t.Fatal(e)
		}
		if _, e = archive.Write([]byte("body")); e != nil {
			t.Fatal(e)
		}
	}
	if e = archive.Close(); e != nil {
		t.Fatal(e)
	}
	if e = encoder.Close(); e != nil {
		t.Fatal(e)
	}
	return output.Bytes()
}

func TestCheckpointTransferRejectsMembersBeforeNative(t *testing.T) {
	for _, members := range [][]string{{"../snapshot.mem", "snapshot.qcow2"}, {"snapshot.mem", "snapshot.mem"}, {"snapshot.mem"}} {
		t.Run(strings.Join(members, ","), func(t *testing.T) {
			service, native, _ := newCheckpointFixture(t)
			_, e := service.Stage(context.Background(), checkpointTestOperation, checkpointTestOrganization, bytes.NewReader(pairTransferFixture(t, members)))
			if !sdk.IsInvalidArgument(e) {
				t.Fatalf("invalid members accepted: %v", e)
			}
			if len(native.calls) != 0 {
				t.Fatal("invalid archive reached native")
			}
		})
	}
}

func TestCheckpointRawRegistrationPinsUntilRestoreCompletion(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	ctx := context.Background()
	if _, e := service.Stage(ctx, checkpointTestOperation, checkpointTestOrganization, bytes.NewReader(pairTransferFixture(t, []string{"snapshot.mem", "snapshot.qcow2"}))); e != nil {
		t.Fatal(e)
	}
	registration := CheckpointRegistration{OrganizationID: checkpointTestOrganization, OperationID: checkpointTestOperation, ExpectedPairSHA256: native.inspection.PairSHA256}
	if _, e := service.Register(ctx, checkpointTestOperation, registration); e != nil {
		t.Fatal(e)
	}
	native.block = make(chan struct{})
	release := make(chan struct{})
	native.block = release
	native.entered = make(chan struct{})
	job := CheckpointJob{Kind: "IMPORT_CHECKPOINT", BoxID: checkpointTestBox, OperationID: checkpointTestResource, CheckpointID: checkpointTestResource, NativeCheckpointID: checkpointTestOperation, ContentSHA256: native.inspection.PairSHA256, OrganizationID: checkpointTestOrganization, CPU: 2, MemoryMiB: 1024}
	job.Configuration, _ = json.Marshal(native.inspection.Configuration)
	restored := make(chan error, 1)
	go func() { _, e := service.Execute(ctx, job); restored <- e }()
	<-native.entered
	deleted := make(chan error, 1)
	go func() { deleted <- service.Delete(ctx, checkpointTestOperation) }()
	select {
	case e := <-deleted:
		t.Fatalf("delete raced native restore: %v", e)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if e := <-restored; e != nil {
		t.Fatal(e)
	}
	if e := <-deleted; e != nil {
		t.Fatal(e)
	}
	// The target owns its copied boot, and replay is answered by the durable
	// completion even after the transfer registration has been removed.
	if _, e := service.Execute(ctx, job); e != nil {
		t.Fatalf("completed restore required deleted transfer: %v", e)
	}
}

func TestCheckpointRegistrationRejectsDifferentOrganizationAndDigest(t *testing.T) {
	service, native, _ := newCheckpointFixture(t)
	if _, e := service.Stage(context.Background(), checkpointTestOperation, checkpointTestOrganization, bytes.NewReader(pairTransferFixture(t, []string{"snapshot.mem", "snapshot.qcow2"}))); e != nil {
		t.Fatal(e)
	}
	for _, request := range []CheckpointRegistration{{OperationID: checkpointTestOperation, OrganizationID: checkpointTestResource, ExpectedPairSHA256: native.inspection.PairSHA256}, {OperationID: checkpointTestOperation, OrganizationID: checkpointTestOrganization, ExpectedPairSHA256: strings.Repeat("c", 64)}} {
		if _, e := service.Register(context.Background(), checkpointTestOperation, request); !sdk.IsInvalidState(e) {
			t.Fatalf("mismatch accepted: %v", e)
		}
	}
}

func TestCheckpointActualNativeInspectionRetainsMalformedInputClass(t *testing.T) {
	directory := t.TempDir()
	if e := os.WriteFile(filepath.Join(directory, "snapshot.mem"), []byte("short"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(directory, "snapshot.qcow2"), []byte("short"), 0600); e != nil {
		t.Fatal(e)
	}
	_, e := sdkCheckpointNative{}.inspect(directory)
	if !sdk.IsInvalidArgument(e) {
		t.Fatalf("native inspection lost input error: %v", e)
	}
}
