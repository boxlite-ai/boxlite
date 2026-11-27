// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"maps"
	"strings"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/checkpoint"
)

func (c *Client) nativeBoxID(target string) (string, error) {
	if c.homeDir == "" {
		return target, nil
	}
	allocation, err := c.checkpointOperations().ProtectedAllocation(target)
	if err != nil {
		return "", err
	}
	if allocation != nil && allocation.NativeID != "" {
		return allocation.NativeID, nil
	}
	return c.checkpointOperations().Resolve(target)
}

func (c *Client) nativeBoxInfo(ctx context.Context, target string) (*sdk.BoxInfo, error) {
	id, err := c.nativeBoxID(target)
	if err != nil {
		return nil, err
	}
	info, err := c.runtime.GetInfo(ctx, id)
	if err == nil && id != target {
		info.Name = target
	}
	return info, err
}

func (c *Client) listPublicBoxes(ctx context.Context) ([]sdk.BoxInfo, error) {
	boxes, err := c.runtime.ListInfo(ctx)
	if err != nil || c.homeDir == "" {
		return boxes, err
	}
	bindings, err := c.checkpointOperations().Bindings()
	if err != nil {
		return nil, err
	}
	allocations, err := c.checkpointOperations().ProtectedAllocationBindings()
	if err != nil {
		return nil, err
	}
	maps.Copy(bindings, allocations)
	byNativeID := make(map[string]string, len(bindings))
	for target, id := range bindings {
		byNativeID[id] = target
	}
	visible := boxes[:0]
	for _, info := range boxes {
		if target := byNativeID[info.ID]; target != "" {
			info.Name = target
		} else if strings.HasPrefix(info.Name, "checkpoint-") || bindings[info.Name] != "" {
			continue
		} else if strings.HasPrefix(info.Name, checkpoint.ProtectedAllocationPrefix) {
			attempt, err := c.nativeRunnerAllocation(ctx, info.ID)
			if sdk.IsNotFound(err) || attempt != "" {
				continue
			}
			if err != nil {
				return nil, err
			}
		}
		visible = append(visible, info)
	}
	return visible, nil
}
