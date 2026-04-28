// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package common

var commandAliases = map[string][]string{
	"create":    {"add", "new"},
	"delete":    {"remove", "rm"},
	"update":    {"set"},
	"install":   {"i"},
	"uninstall": {"u"},
	"info":      {"view", "inspect"},
	"code":      {"open"},
	"logs":      {"log"},
	"forward":   {"fwd"},
	"list":      {"ls"},
}

func GetAliases(cmd string) []string {
	if aliases, exists := commandAliases[cmd]; exists {
		return aliases
	}
	return nil
}
