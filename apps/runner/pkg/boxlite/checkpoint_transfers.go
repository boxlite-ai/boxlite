// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
)

type checkpointTransfer struct {
	ID             string                         `json:"id"`
	OrganizationID string                         `json:"organizationId"`
	Kind           string                         `json:"kind"`
	Deleted        bool                           `json:"deleted"`
	Inspection     *sdk.CloudCheckpointInspection `json:"inspection,omitempty"`
	NativeID       string                         `json:"nativeId,omitempty"`
	Registered     bool                           `json:"registered,omitempty"`
	BoxID          string                         `json:"boxId,omitempty"`
}

type CheckpointRegistration struct {
	OrganizationID     string `json:"organizationId"`
	OperationID        string `json:"operationId"`
	ExpectedPairSHA256 string `json:"expectedPairSha256"`
	BootArchiveURI     string `json:"bootArchiveUri,omitempty"`
}

func (s *CheckpointService) transferPath(id string) string {
	return filepath.Join(s.root, "transfer-records", id+".json")
}
func (s *CheckpointService) transferDirectory(id string) string {
	return filepath.Join(s.root, "transfers", id)
}
func (s *CheckpointService) readTransfer(id string) (*checkpointTransfer, error) {
	var record checkpointTransfer
	bytes, e := os.ReadFile(s.transferPath(id))
	if errors.Is(e, os.ErrNotExist) {
		return nil, checkpointError(sdk.ErrNotFound, "checkpoint transfer does not exist")
	}
	if e != nil {
		return nil, checkpointStorageError(e)
	}
	if e = json.Unmarshal(bytes, &record); e != nil {
		return nil, checkpointError(sdk.ErrStorage, "invalid checkpoint transfer record")
	}
	return &record, nil
}
func (s *CheckpointService) saveTransfer(record *checkpointTransfer) error {
	return checkpointStorageError(writeCheckpointJSON(s.transferPath(record.ID), record))
}

func (s *CheckpointService) Stage(ctx context.Context, id, organization string, input io.Reader) (*sdk.CloudCheckpointInspection, error) {
	end, err := s.beginConsumer()
	if err != nil {
		return nil, err
	}
	defer end()
	if !canonicalUUID(id) || !canonicalUUID(organization) {
		return nil, checkpointError(sdk.ErrInvalidArgument, "transfer and organization UUIDs are required")
	}
	if !s.supported {
		return nil, checkpointError(sdk.ErrUnsupported, "memory checkpoints are unsupported on this runner")
	}
	unlock := s.lock("transfer:" + id)
	defer unlock()
	if _, e := s.readTransfer(id); e == nil {
		return nil, checkpointError(sdk.ErrInvalidState, "checkpoint transfer already exists")
	} else {
		var native *sdk.Error
		if !errors.As(e, &native) || native.Code != sdk.ErrNotFound {
			return nil, e
		}
	}
	record := &checkpointTransfer{ID: id, OrganizationID: organization, Kind: "upload"}
	if e := s.saveTransfer(record); e != nil {
		return nil, e
	}
	directory := s.transferDirectory(id)
	if e := os.MkdirAll(directory, 0700); e != nil {
		return nil, checkpointStorageError(e)
	}
	compressed, e := os.OpenFile(filepath.Join(directory, "upload.tar.zst"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return nil, checkpointStorageError(e)
	}
	defer compressed.Close()
	n, e := io.Copy(compressed, io.LimitReader(input, checkpointTransferLimit+1))
	if e != nil {
		return nil, checkpointTransportError(e)
	}
	if n > checkpointTransferLimit {
		return nil, checkpointError(sdk.ErrInvalidArgument, "checkpoint transfer exceeds 16 GiB")
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	if _, e = compressed.Seek(0, 0); e != nil {
		return nil, checkpointStorageError(e)
	}
	pair := filepath.Join(directory, "pair")
	if e = unpackCheckpointPair(compressed, pair); e != nil {
		return nil, e
	}
	inspection, e := s.native.inspect(pair)
	if e != nil {
		return nil, e
	}
	record.Inspection = inspection
	if e = s.saveTransfer(record); e != nil {
		return nil, e
	}
	return inspection, nil
}

func (s *CheckpointService) Register(ctx context.Context, id string, request CheckpointRegistration) (string, error) {
	end, err := s.beginConsumer()
	if err != nil {
		return "", err
	}
	defer end()
	if !canonicalUUID(id) || request.OperationID != id || !canonicalUUID(request.OrganizationID) || !validDigest(request.ExpectedPairSHA256) {
		return "", checkpointError(sdk.ErrInvalidArgument, "invalid checkpoint registration identity")
	}
	unlock := s.lock("transfer:" + id)
	defer unlock()
	record, e := s.readTransfer(id)
	if e != nil {
		return "", e
	}
	if record.Deleted || record.Kind != "upload" || record.OrganizationID != request.OrganizationID || record.Inspection == nil || record.Inspection.PairSHA256 != request.ExpectedPairSHA256 {
		return "", checkpointError(sdk.ErrInvalidState, "checkpoint transfer is not an admitted matching upload")
	}
	if record.Registered {
		if e = writeCheckpointJSON(filepath.Join(s.root, "registrations", record.NativeID+".json"), record); e != nil {
			return "", checkpointStorageError(e)
		}
		return record.NativeID, nil
	}
	directory := s.transferDirectory(id)
	trustedBoot := ""
	if request.BootArchiveURI != "" {
		if s.store == nil {
			return "", checkpointError(sdk.ErrUnsupported, "checkpoint object storage is unavailable")
		}
		if !validCheckpointURI(request.BootArchiveURI, request.OrganizationID) {
			return "", checkpointError(sdk.ErrInvalidArgument, "boot archive does not belong to the organization")
		}
		archive := filepath.Join(directory, "trusted-boot.tar.zst")
		if e = s.store.Download(ctx, request.BootArchiveURI, archive); e != nil {
			return "", checkpointStorageError(e)
		}
		trustedBoot = filepath.Join(directory, "boot.raw")
		_ = os.Remove(trustedBoot)
		if e = extractCheckpointBoot(archive, trustedBoot, record.Inspection.BootDiskSHA256); e != nil {
			return "", e
		}
	}
	// Native registration publishes under operationId. Persist ownership before
	// submitting so a lost response or failed index write is still cleanable.
	record.NativeID = id
	if e = s.saveTransfer(record); e != nil {
		return "", e
	}
	info, e := s.native.register(context.WithoutCancel(ctx), filepath.Join(directory, "pair"), sdk.CloudCheckpointImportOptions{OperationID: id, ExpectedPairSHA256: request.ExpectedPairSHA256, TrustedBoot: trustedBoot})
	if e != nil {
		return "", e
	}
	if info.Id != id {
		return "", checkpointError(sdk.ErrInvalidState, "native registration returned a different operation identity")
	}
	record.Registered = true
	if e = s.saveTransfer(record); e != nil {
		return "", e
	}
	// The reverse identity pins the transfer while a raw-import job owns it.
	if e = writeCheckpointJSON(filepath.Join(s.root, "registrations", info.Id+".json"), record); e != nil {
		return "", checkpointStorageError(e)
	}
	return info.Id, nil
}

// Match the native BoxID parser: IDs are opaque; UUIDs are only one format.
func validBoxID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range []byte(value) {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (s *CheckpointService) Export(ctx context.Context, id, boxID, organization, operation string, output io.Writer) error {
	end, err := s.beginConsumer()
	if err != nil {
		return err
	}
	defer end()
	if !canonicalUUID(id) || operation != id || !canonicalUUID(organization) || !validBoxID(boxID) {
		return checkpointError(sdk.ErrInvalidArgument, "invalid checkpoint export identity")
	}
	if !s.supported {
		return checkpointError(sdk.ErrUnsupported, "memory checkpoints are unsupported on this runner")
	}
	unlock := s.lock("transfer:" + id)
	defer unlock()
	boxUnlock := s.lock("box:" + boxID)
	defer boxUnlock()
	record, e := s.readTransfer(id)
	if e == nil {
		if record.Deleted || record.Kind != "export" || record.BoxID != boxID || record.OrganizationID != organization {
			return checkpointError(sdk.ErrInvalidState, "checkpoint export identity conflict")
		}
	} else {
		var native *sdk.Error
		if !errors.As(e, &native) || native.Code != sdk.ErrNotFound {
			return e
		}
		record = &checkpointTransfer{ID: id, OrganizationID: organization, Kind: "export", BoxID: boxID}
		if e = s.saveTransfer(record); e != nil {
			return e
		}
	}
	directory := s.transferDirectory(id)
	if e = os.MkdirAll(directory, 0700); e != nil {
		return checkpointStorageError(e)
	}
	archive := filepath.Join(directory, "export.tar.zst")
	if _, e = os.Stat(archive); errors.Is(e, os.ErrNotExist) {
		pair := filepath.Join(directory, "pair")
		if e = os.RemoveAll(pair); e != nil {
			return checkpointStorageError(e)
		}
		if e = s.native.exportPair(context.WithoutCancel(ctx), boxID, pair); e != nil {
			return e
		}
		if e = packCheckpointPair(pair, archive); e != nil {
			return e
		}
	}
	file, e := os.Open(archive)
	if e != nil {
		return checkpointStorageError(e)
	}
	defer file.Close()
	_, e = io.Copy(output, file)
	return e
}

// Delete waits behind every transfer/native consumer. It leaves a tombstone so
// a replayed request cannot reuse an identity after its resource was removed.
func (s *CheckpointService) Delete(ctx context.Context, id string) error {
	end, err := s.beginConsumer()
	if err != nil {
		return err
	}
	defer end()
	if !canonicalUUID(id) {
		return checkpointError(sdk.ErrInvalidArgument, "transfer UUID is required")
	}
	unlock := s.lock("transfer:" + id)
	defer unlock()
	record, e := s.readTransfer(id)
	if e != nil {
		var native *sdk.Error
		if errors.As(e, &native) && native.Code == sdk.ErrNotFound {
			return nil
		}
		return e
	}
	if record.NativeID != "" {
		if e = s.native.remove(context.WithoutCancel(ctx), record.NativeID); e != nil && !sdk.IsNotFound(e) {
			return e
		}
	}
	record.Deleted = true
	if e = s.saveTransfer(record); e != nil {
		return e
	}
	return checkpointStorageError(os.RemoveAll(s.transferDirectory(id)))
}

func (s *CheckpointService) pinRegistration(job CheckpointJob) (func(), error) {
	bytes, e := os.ReadFile(filepath.Join(s.root, "registrations", job.NativeCheckpointID+".json"))
	if e != nil {
		return nil, checkpointError(sdk.ErrInvalidState, "native registration does not belong to this runner")
	}
	var index checkpointTransfer
	if e = json.Unmarshal(bytes, &index); e != nil {
		return nil, checkpointStorageError(e)
	}
	unlock := s.lock("transfer:" + index.ID)
	record, e := s.readTransfer(index.ID)
	if e != nil {
		unlock()
		return nil, e
	}
	if record.Deleted || !record.Registered || record.NativeID != job.NativeCheckpointID || record.OrganizationID != job.OrganizationID || record.Inspection == nil || record.Inspection.PairSHA256 != job.ContentSHA256 || int(record.Inspection.Resources.CPUs) != job.CPU || int(record.Inspection.Resources.MemoryMiB) != job.MemoryMiB {
		unlock()
		return nil, checkpointError(sdk.ErrInvalidState, "native registration differs from the admitted checkpoint")
	}
	var admitted sdk.CloudCheckpointConfiguration
	if len(job.Configuration) == 0 || json.Unmarshal(job.Configuration, &admitted) != nil || !reflect.DeepEqual(normalizeCheckpointConfiguration(admitted), normalizeCheckpointConfiguration(record.Inspection.Configuration)) {
		unlock()
		return nil, checkpointError(sdk.ErrInvalidState, "checkpoint configuration differs from admission")
	}
	return unlock, nil
}

func normalizeCheckpointConfiguration(configuration sdk.CloudCheckpointConfiguration) sdk.CloudCheckpointConfiguration {
	// The API's allowlist omits inbound allow_net and serializes empty lists
	// independently of Go's nil slices; both represent the same native policy.
	configuration.Inbound.AllowNet = nil
	if len(configuration.Outbound.AllowNet) == 0 {
		configuration.Outbound.AllowNet = nil
	}
	if len(configuration.Env) == 0 {
		configuration.Env = nil
	}
	return configuration
}
