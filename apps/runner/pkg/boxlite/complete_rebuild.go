// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func (c *Client) RebuildCompleteOutbound(ctx context.Context, target string, request dto.CompleteRebuildRequest) (sdk.CompleteOutboundSnapshot, error) {
	var absent sdk.CompleteOutboundSnapshot
	if request.Stamp <= 0 || !sdk.ValidOutboundRevision(target) ||
		!sdk.ValidOutboundRevision(request.Snapshot.Revision) ||
		request.Box.OutboundEnabled != nil || len(request.Box.OutboundAllowNet) != 0 {
		return absent, &sdk.Error{Code: sdk.ErrInvalidArgument, Message: "invalid complete rebuild identity"}
	}
	recoverDto := recoverCreateDto(target, request.Box)
	resources, err := validateCreateResources(recoverDto)
	if err != nil {
		return absent, err
	}
	if err := validateRecreatableSecrets(recoverDto.Secrets); err != nil {
		return absent, err
	}
	lease, err := c.lockCheckpointTarget(ctx, target)
	if err != nil {
		return absent, err
	}
	defer lease.Close()
	canonical, err := json.Marshal(request)
	if err != nil {
		return absent, err
	}
	digest := sha256.Sum256(canonical)
	fingerprint := hex.EncodeToString(digest[:])
	record, err := lease.CompleteRebuildFor(request.Stamp, fingerprint)
	if err != nil {
		return absent, err
	}
	info, err := c.nativeBoxInfo(ctx, target)
	if err != nil && !sdk.IsNotFound(err) {
		return absent, err
	}
	if record == nil {
		if info == nil {
			return absent, checkpoint.ErrCompleteCreateConflict
		}
		record = &checkpoint.CompleteRebuild{Stamp: request.Stamp, Fingerprint: fingerprint, PreviousID: info.ID}
	}
	if record.CompletedID != "" {
		if info == nil || record.CompletedID != info.ID {
			return absent, checkpoint.ErrCompleteCreateConflict
		}
		proof, err := c.checkCompleteRebuild(ctx, target, request.Snapshot, false)
		if err != nil {
			return absent, err
		}
		return *proof.Snapshot, nil
	}
	if info != nil {
		// Pin the selected backend before the predecessor can be removed.
		proof, err := c.checkCompleteRebuild(ctx, target, request.Snapshot, record.RebuildPin == "")
		if err != nil {
			return absent, err
		}
		if record.RebuildPin == "" {
			record.RebuildPin = proof.RebuildPin
		}
	}
	if info != nil && info.ID == record.PreviousID {
		if err := lease.SaveCompleteRebuild(*record); err != nil {
			return absent, err
		}
		if err := c.destroy(ctx, target, lease); err != nil {
			return absent, err
		}
		info = nil
	}
	if info != nil && info.State == sdk.StateRunning {
		return absent, checkpoint.ErrCompleteCreateConflict
	}
	if err := lease.ClearPublished(); err != nil {
		return absent, err
	}
	skipStart := true
	recoverDto.SkipStart = &skipStart
	network := sdk.NetworkSpec{Outbound: sdk.OutboundNetworkSpec{Mode: sdk.NetworkModeEnabled}}
	prepared := completeCreatePreparation{rebuild: true, prepared: sdk.PreparedOutboundCreate{
		Snapshot: request.Snapshot, DenyPresent: len(request.Snapshot.Policy.DenyNet) != 0,
		RebuildPin: record.RebuildPin,
	}}
	id, _, err := c.create(context.WithoutCancel(ctx), recoverDto, lease, resources, network, &prepared)
	if err != nil {
		return absent, err
	}
	proof, err := c.checkCompleteRebuild(context.WithoutCancel(ctx), target, request.Snapshot, false)
	if err != nil {
		return absent, err
	}
	record.CompletedID = id
	return *proof.Snapshot, lease.SaveCompleteRebuild(*record)
}

func (c *Client) checkCompleteRebuild(ctx context.Context, target string, expected sdk.CompleteOutboundSnapshot, pinBackend bool) (sdk.HostedOutboundReceipt, error) {
	var absent sdk.HostedOutboundReceipt
	command, err := json.Marshal(struct {
		Operation  string                       `json:"operation"`
		Snapshot   sdk.CompleteOutboundSnapshot `json:"snapshot"`
		PinBackend bool                         `json:"pin_backend"`
	}{"check_rebuild", expected, pinBackend})
	if err != nil {
		return absent, err
	}
	network, err := c.outboundNetwork(ctx, target)
	if err != nil {
		return absent, err
	}
	defer network.Close()
	proof, err := network.HostedOutbound(ctx, command)
	if err != nil {
		return absent, err
	}
	if proof.Outcome != "rebuild_ready" || proof.Snapshot == nil ||
		!sameCompleteCreateSnapshot(*proof.Snapshot, expected) || pinBackend != (proof.RebuildPin != "") {
		return absent, checkpoint.ErrCompleteCreateConflict
	}
	return proof, nil
}
