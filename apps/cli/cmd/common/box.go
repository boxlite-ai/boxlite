// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"fmt"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func RequireStartedState(box *apiclient.Box) error {
	if box.State == nil {
		return fmt.Errorf("box state is unknown")
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
		return fmt.Errorf("box is stopped. Start it with: boxlite box start %s", boxRef)
	case apiclient.BOXSTATE_ARCHIVED:
		return fmt.Errorf("box is archived and cannot be used")
	case apiclient.BOXSTATE_ARCHIVING:
		return fmt.Errorf("box is archiving and cannot be used")
	case apiclient.BOXSTATE_STARTING:
		return fmt.Errorf("box is starting. Please wait for it to be ready")
	case apiclient.BOXSTATE_STOPPING:
		return fmt.Errorf("box is stopping. Please wait for it to complete")
	case apiclient.BOXSTATE_CREATING:
		return fmt.Errorf("box is being created. Please wait for it to be ready")
	case apiclient.BOXSTATE_DESTROYING:
		return fmt.Errorf("box is being destroyed")
	case apiclient.BOXSTATE_DESTROYED:
		return fmt.Errorf("box has been destroyed")
	case apiclient.BOXSTATE_ERROR:
		return fmt.Errorf("box is in an error state")
	case apiclient.BOXSTATE_BUILD_FAILED:
		return fmt.Errorf("box build failed")
	default:
		return fmt.Errorf("box is not running (state: %s)", state)
	}
}
