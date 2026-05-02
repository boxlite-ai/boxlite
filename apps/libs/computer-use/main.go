// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"os"

	cu "github.com/boxlite-ai/computer-use/pkg/computeruse"
	"github.com/boxlite-ai/daemon/pkg/toolbox/computeruse"
	"github.com/boxlite-ai/daemon/pkg/toolbox/computeruse/manager"
	"github.com/hashicorp/go-hclog"
	hc_plugin "github.com/hashicorp/go-plugin"
)

func main() {
	logger := hclog.New(&hclog.LoggerOptions{
		Level:      hclog.Trace,
		Output:     os.Stderr,
		JSONFormat: true,
	})
	hc_plugin.Serve(&hc_plugin.ServeConfig{
		HandshakeConfig: manager.ComputerUseHandshakeConfig,
		Plugins: map[string]hc_plugin.Plugin{
			"boxlite-computer-use": &computeruse.ComputerUsePlugin{Impl: &cu.ComputerUse{}},
		},
		Logger: logger,
	})
}
