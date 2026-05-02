// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package computeruse

import (
	"fmt"
	"strings"

	"github.com/boxlite-ai/daemon/pkg/toolbox/computeruse"
	"github.com/go-vgo/robotgo"
)

func (u *ComputerUse) TypeText(req *computeruse.KeyboardTypeRequest) (*computeruse.Empty, error) {
	if req.Delay > 0 {
		robotgo.TypeStr(req.Text, req.Delay)
	} else {
		robotgo.TypeStr(req.Text)
	}

	return new(computeruse.Empty), nil
}

func (u *ComputerUse) PressKey(req *computeruse.KeyboardPressRequest) (*computeruse.Empty, error) {
	if len(req.Modifiers) > 0 {
		err := robotgo.KeyTap(req.Key, req.Modifiers)
		if err != nil {
			return nil, err
		}
	} else {
		err := robotgo.KeyTap(req.Key)
		if err != nil {
			return nil, err
		}
	}

	return new(computeruse.Empty), nil
}

func (u *ComputerUse) PressHotkey(req *computeruse.KeyboardHotkeyRequest) (*computeruse.Empty, error) {
	keys := strings.Split(req.Keys, "+")
	if len(keys) < 2 {
		return nil, fmt.Errorf("invalid hotkey format")
	}

	mainKey := keys[len(keys)-1]
	modifiers := keys[:len(keys)-1]

	err := robotgo.KeyTap(mainKey, modifiers)
	if err != nil {
		return nil, err
	}

	return new(computeruse.Empty), nil
}
