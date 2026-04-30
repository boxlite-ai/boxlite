// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package util

import (
	"github.com/boxlite-labs/boxlite/cli/views/common"
)

func NotifyEmptySandboxList(tip bool) {
	common.RenderInfoMessageBold("No sandboxes found")
	if tip {
		common.RenderTip("Use the BoxLite SDK to get started.")
	}
}

func NotifyEmptySnapshotList(tip bool) {
	common.RenderInfoMessageBold("No snapshots found")
	if tip {
		common.RenderTip("Use 'boxlite snapshot push' to push a snapshot.")
	}
}

func NotifyEmptyOrganizationList(tip bool) {
	common.RenderInfoMessageBold("No organizations found")
	if tip {
		common.RenderTip("Use 'boxlite organization create' to create an organization.")
	}
}

func NotifyEmptyVolumeList(tip bool) {
	common.RenderInfoMessageBold("No volumes found")
	if tip {
		common.RenderTip("Use 'boxlite volume create' to create a volume.")
	}
}
