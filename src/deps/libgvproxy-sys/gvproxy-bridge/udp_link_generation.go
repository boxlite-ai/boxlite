package main

import (
	"context"
	"errors"
	"sync"
)

var errUDPGuestLinkUncertain = errors.New("old UDP frame left the guest link unusable for confirmation")

// udpLinkGeneration is the packet owner attached to managed relay replies.
// Its seal and final write admissions share one lock so ACK cannot race a
// write starting after the seal.
type udpLinkGeneration struct {
	mu        sync.Mutex
	sealed    chan struct{}
	drained   chan struct{}
	active    int
	uncertain bool
}

func newUDPLinkGeneration() *udpLinkGeneration {
	return &udpLinkGeneration{sealed: make(chan struct{}), drained: make(chan struct{})}
}

func (*udpLinkGeneration) KUID() uint32 { return 0 }
func (*udpLinkGeneration) KGID() uint32 { return 0 }

func (g *udpLinkGeneration) isSealed() bool {
	select {
	case <-g.sealed:
		return true
	default:
		return false
	}
}

func (g *udpLinkGeneration) admit() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.isSealed() {
		return false
	}
	g.active++
	return true
}

func (g *udpLinkGeneration) finish(uncertain bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.uncertain = g.uncertain || uncertain
	g.active--
	if g.active == 0 && g.isSealed() {
		close(g.drained)
	}
}

func (g *udpLinkGeneration) seal() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.isSealed() {
		return
	}
	close(g.sealed)
	if g.active == 0 {
		close(g.drained)
	}
}

func (g *udpLinkGeneration) wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-g.drained:
		if err := ctx.Err(); err != nil {
			return err
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.uncertain {
			return errUDPGuestLinkUncertain
		}
		return nil
	}
}
