/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"fmt"
	"sync"
)

// boxOperations tracks the snapshot job working on each box's disk, so that
// destroying the box can stop that job first. The poller runs jobs in
// parallel, and nothing else would keep a DESTROY_BOX from removing the disk
// out from under an export or a restore that then reports something stale.
type boxOperations struct {
	mu        sync.Mutex
	running   map[string]*boxOperation
	destroyed map[string]struct{}
}

type boxOperation struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// begin registers an operation on boxId and returns the context it must run
// under and the function that ends it. The control plane admits one snapshot
// job per box, so a second begin for the same box is refused rather than
// queued.
func (o *boxOperations) begin(ctx context.Context, boxId string) (context.Context, func(), error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, destroyed := o.destroyed[boxId]; destroyed {
		return nil, nil, fmt.Errorf("box %s was destroyed", boxId)
	}

	if o.running == nil {
		o.running = make(map[string]*boxOperation)
	}
	if _, busy := o.running[boxId]; busy {
		return nil, nil, fmt.Errorf("box %s already has a snapshot job running", boxId)
	}

	opCtx, cancel := context.WithCancel(ctx)
	op := &boxOperation{cancel: cancel, done: make(chan struct{})}
	o.running[boxId] = op

	end := func() {
		o.mu.Lock()
		delete(o.running, boxId)
		o.mu.Unlock()
		cancel()
		close(op.done)
	}
	return opCtx, end, nil
}

// cancel refuses future disk work and cancels the active operation, if any.
// The destroy owns waiting for done: cancellation alone cannot stop native
// work or establish that removing its disk is safe.
func (o *boxOperations) cancel(boxId string) <-chan struct{} {
	o.mu.Lock()
	if o.destroyed == nil {
		o.destroyed = make(map[string]struct{})
	}
	o.destroyed[boxId] = struct{}{}
	op := o.running[boxId]
	o.mu.Unlock()
	if op == nil {
		return nil
	}

	op.cancel()
	return op.done
}
