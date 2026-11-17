// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package sshusage drains guest evidence exclusively from a background loop.
package sshusage

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"sync"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/common-go/pkg/featureusage"
)

const (
	pollInterval = 5 * time.Second
	maxBoxes     = 64
	workers      = 4
)

type Source interface {
	ListInfo(context.Context) ([]boxlite.BoxInfo, error)
	TakeSSHUsage(context.Context, string) (*boxlite.SSHUsageBatch, error)
}

type Collector struct {
	source      Source
	record      func(featureusage.Event) bool
	logger      *slog.Logger
	cursor      string
	unavailable map[string]bool
	drops       map[string]uint64
	listFailed  bool
}

func New(source Source, record func(featureusage.Event) bool, logger *slog.Logger) *Collector {
	return &Collector{source: source, record: record, logger: logger, unavailable: make(map[string]bool), drops: make(map[string]uint64)}
}

func (c *Collector) Run(ctx context.Context) {
	timer := time.NewTicker(pollInterval)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		c.poll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

type observation struct {
	box   boxlite.BoxInfo
	batch *boxlite.SSHUsageBatch
	err   error
}

func (c *Collector) poll(ctx context.Context) {
	boxes, err := c.source.ListInfo(ctx)
	if err != nil {
		if !c.listFailed {
			c.logger.WarnContext(ctx, "SSH usage listing unavailable")
		}
		c.listFailed = true
		return
	}
	c.listFailed = false
	active := boxes[:0]
	present := make(map[string]bool)
	for _, box := range boxes {
		if box.Running && cloudBoxID(box.Name) {
			active = append(active, box)
			present[box.ID] = true
		}
	}
	for id := range c.unavailable {
		if !present[id] {
			delete(c.unavailable, id)
		}
	}
	for id := range c.drops {
		if !present[id] {
			delete(c.drops, id)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].ID < active[j].ID })
	if len(active) == 0 {
		return
	}
	start := sort.Search(len(active), func(i int) bool { return active[i].ID > c.cursor })
	if start == len(active) {
		start = 0
	}
	count := min(len(active), maxBoxes)
	jobs := make(chan boxlite.BoxInfo, count)
	results := make(chan observation, count)
	for i := 0; i < count; i++ {
		jobs <- active[(start+i)%len(active)]
	}
	c.cursor = active[(start+count-1)%len(active)].ID
	close(jobs)
	var group sync.WaitGroup
	for range min(workers, count) {
		group.Add(1)
		go func() {
			defer group.Done()
			for box := range jobs {
				if ctx.Err() != nil {
					return
				}
				callCtx, cancel := context.WithTimeout(ctx, time.Second)
				batch, err := c.source.TakeSSHUsage(callCtx, box.ID)
				cancel()
				results <- observation{box: box, batch: batch, err: err}
			}
		}()
	}
	group.Wait()
	close(results)
	for result := range results {
		id := result.box.ID
		if result.err != nil || result.batch == nil {
			if !c.unavailable[id] && ctx.Err() == nil {
				c.logger.WarnContext(ctx, "SSH usage unavailable", "boxId", result.box.Name)
			}
			c.unavailable[id] = true
			continue
		}
		delete(c.unavailable, id)
		if result.batch.DroppedTotal != c.drops[id] {
			c.logger.WarnContext(ctx, "Guest SSH usage buffer dropped observations", "boxId", result.box.Name, "droppedTotal", result.batch.DroppedTotal)
			c.drops[id] = result.batch.DroppedTotal
		}
		for _, event := range result.batch.Events {
			if event.OccurredAtMS > math.MaxInt64 {
				continue
			}
			c.record(featureusage.Event{ID: event.ID, BoxID: result.box.Name, Kind: featureusage.SSH, OccurredAt: time.UnixMilli(int64(event.OccurredAtMS)).UTC()})
		}
	}
}

func cloudBoxID(value string) bool {
	if len(value) != 12 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}
