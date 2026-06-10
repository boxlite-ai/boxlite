// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"fmt"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func RequireStartedState(box *apiclient.Box) error {
	if box.State == nil {
		return fmt.Errorf("sandbox state is unknown")
	}

	state := *box.State
	if state == apiclient.BOXSTATE_STARTED {
		return nil
	}

	boxRef := box.Id
	if box.Name != "" {
		boxRef = box.Name
	}

	switch state {
	case apiclient.BOXSTATE_STOPPED:
		return fmt.Errorf("sandbox is stopped. Start it with: boxlite box start %s", boxRef)
	case apiclient.BOXSTATE_ARCHIVED:
		return fmt.Errorf("sandbox is archived and cannot be used")
	case apiclient.BOXSTATE_ARCHIVING:
		return fmt.Errorf("sandbox is archiving and cannot be used")
	case apiclient.BOXSTATE_STARTING:
		return fmt.Errorf("sandbox is starting. Please wait for it to be ready")
	case apiclient.BOXSTATE_STOPPING:
		return fmt.Errorf("sandbox is stopping. Please wait for it to complete")
	case apiclient.BOXSTATE_CREATING:
		return fmt.Errorf("sandbox is being created. Please wait for it to be ready")
	case apiclient.BOXSTATE_DESTROYING:
		return fmt.Errorf("sandbox is being destroyed")
	case apiclient.BOXSTATE_DESTROYED:
		return fmt.Errorf("sandbox has been destroyed")
	case apiclient.BOXSTATE_ERROR:
		return fmt.Errorf("sandbox is in an error state")
	case apiclient.BOXSTATE_BUILD_FAILED:
		return fmt.Errorf("sandbox build failed")
	default:
		return fmt.Errorf("sandbox is not running (state: %s)", state)
	}
}
