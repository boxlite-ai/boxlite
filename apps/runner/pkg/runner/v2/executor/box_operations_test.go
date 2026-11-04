/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

package executor

import (
	"context"
	"testing"
	"time"
)

func TestSnapshotCancellationWaitsForDiskRelease(t *testing.T) {
	var operations boxOperations
	ctx, end, err := operations.begin(context.Background(), "box")
	if err != nil {
		t.Fatal(err)
	}
	returned := make(chan struct{})
	go func() {
		<-operations.cancel("box")
		close(returned)
	}()
	<-ctx.Done()
	early := false
	select {
	case <-returned:
		early = true
	case <-time.After(25 * time.Millisecond):
	}
	end()
	<-returned
	if early {
		t.Fatal("cancellation returned before the snapshot released its disk")
	}
}
