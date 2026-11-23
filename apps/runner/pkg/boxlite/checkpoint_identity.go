// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"strings"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
)

func (c *Client) nativeBoxID(target string) (string, error) {
	if c.homeDir == "" {
		return target, nil
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
		}
		visible = append(visible, info)
	}
	return visible, nil
}
