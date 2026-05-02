/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package metrics

import (
	"container/ring"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	blclient "github.com/boxlite-labs/runner/pkg/boxlite"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
)

type CollectorConfig struct {
	Logger                             *slog.Logger
	Boxlite                            *blclient.Client
	WindowSize                         int
	CPUUsageSnapshotInterval           time.Duration
	AllocatedResourcesSnapshotInterval time.Duration
}

type Collector struct {
	boxlite *blclient.Client
	log     *slog.Logger

	cpuRing  *ring.Ring
	cpuMutex sync.RWMutex

	resourcesMutex      sync.RWMutex
	allocatedCPU        float32
	allocatedMemoryGiB  float32
	allocatedDiskGiB    float32
	startedSandboxCount float32

	cpuUsageSnapshotInterval           time.Duration
	allocatedResourcesSnapshotInterval time.Duration
}

type CPUSnapshot struct {
	timestamp  time.Time
	cpuPercent float64
}

type Metrics struct {
	CPULoadAverage        float32
	CPUUsagePercentage    float32
	MemoryUsagePercentage float32
	DiskUsagePercentage   float32
	AllocatedCPU          float32
	AllocatedMemoryGiB    float32
	AllocatedDiskGiB      float32
	SnapshotCount         float32
	TotalCPU              float32
	TotalRAMGiB           float32
	TotalDiskGiB          float32
	StartedSandboxCount   float32
}

func NewCollector(cfg CollectorConfig) *Collector {
	return &Collector{
		log:                                cfg.Logger.With(slog.String("component", "metrics")),
		boxlite:                            cfg.Boxlite,
		cpuRing:                            ring.New(cfg.WindowSize),
		cpuUsageSnapshotInterval:           cfg.CPUUsageSnapshotInterval,
		allocatedResourcesSnapshotInterval: cfg.AllocatedResourcesSnapshotInterval,
	}
}

func (c *Collector) Start(ctx context.Context) {
	go c.snapshotCPUUsage(ctx)
	go c.snapshotAllocatedResources(ctx)
}

func (c *Collector) Collect(ctx context.Context) (*Metrics, error) {
	timeout := 30 * time.Second
	timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	for {
		select {
		case <-timeoutCtx.Done():
			return nil, errors.New("timeout collecting metrics")
		default:
			metrics, err := c.collect(timeoutCtx)
			if err != nil {
				c.log.DebugContext(ctx, "Failed to collect metrics", "error", err)
				time.Sleep(1 * time.Second)
				continue
			}

			return metrics, nil
		}
	}
}

func (c *Collector) collect(ctx context.Context) (*Metrics, error) {
	metrics := &Metrics{}

	cpuCount, err := cpu.CountsWithContext(ctx, true)
	if err != nil {
		return nil, fmt.Errorf("failed to collect CPU count: %v", err)
	}
	metrics.TotalCPU = float32(cpuCount)

	loadAvg, err := load.Avg()
	if err != nil {
		return nil, fmt.Errorf("failed to collect CPU load averages: %v", err)
	}
	if cpuCount <= 0 {
		return nil, errors.New("CPU count must be greater than zero")
	}
	metrics.CPULoadAverage = float32(loadAvg.Load15) / float32(cpuCount)

	cpuUsage, err := c.collectCPUUsageAverage()
	if err != nil {
		return nil, fmt.Errorf("failed to collect CPU usage: %v", err)
	}
	metrics.CPUUsagePercentage = float32(cpuUsage)

	memStats, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to collect memory usage: %v", err)
	}
	metrics.MemoryUsagePercentage = float32(memStats.UsedPercent)
	metrics.TotalRAMGiB = float32(memStats.Total) / (1024 * 1024 * 1024)

	diskStats, err := disk.UsageWithContext(ctx, "/")
	if err != nil {
		return nil, fmt.Errorf("failed to collect disk usage: %v", err)
	}
	metrics.DiskUsagePercentage = float32(diskStats.UsedPercent)
	metrics.TotalDiskGiB = float32(diskStats.Total) / (1024 * 1024 * 1024)

	images, err := c.boxlite.ListImages(ctx)
	if err != nil {
		c.log.WarnContext(ctx, "Failed to get image count", "error", err)
	} else {
		metrics.SnapshotCount = float32(len(images))
	}

	c.resourcesMutex.RLock()
	metrics.AllocatedCPU = c.allocatedCPU
	metrics.AllocatedMemoryGiB = c.allocatedMemoryGiB
	metrics.AllocatedDiskGiB = c.allocatedDiskGiB
	metrics.StartedSandboxCount = c.startedSandboxCount
	c.resourcesMutex.RUnlock()

	return metrics, nil
}

func (c *Collector) snapshotCPUUsage(ctx context.Context) {
	ticker := time.NewTicker(c.cpuUsageSnapshotInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.log.InfoContext(ctx, "CPU usage snapshotting stopped")
			return
		case <-ticker.C:
			cpuPercent, err := cpu.PercentWithContext(ctx, 0, false)
			if err != nil {
				c.log.WarnContext(ctx, "Failed to collect next CPU usage ring", "error", err)
				continue
			}

			c.cpuMutex.Lock()
			c.cpuRing.Value = CPUSnapshot{
				timestamp:  time.Now(),
				cpuPercent: cpuPercent[0],
			}
			c.cpuRing = c.cpuRing.Next()
			c.cpuMutex.Unlock()
		}
	}
}

func (c *Collector) collectCPUUsageAverage() (float64, error) {
	var total float64
	var count int

	c.cpuMutex.RLock()
	defer c.cpuMutex.RUnlock()

	c.cpuRing.Do(func(x interface{}) {
		if x != nil {
			snapshot, ok := x.(CPUSnapshot)
			if !ok {
				return
			}

			total += snapshot.cpuPercent
			count++
		}
	})

	if count == 0 {
		return -1.0, errors.New("CPU metrics not yet available")
	}

	return total / float64(count), nil
}

func (c *Collector) snapshotAllocatedResources(ctx context.Context) {
	ticker := time.NewTicker(c.allocatedResourcesSnapshotInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			c.log.InfoContext(ctx, "Allocated resources snapshotting stopped")
			return
		case <-ticker.C:
			boxes, err := c.boxlite.ListInfo(ctx)
			if err != nil {
				c.log.ErrorContext(ctx, "Error listing boxes when getting allocated resources", "error", err)
				continue
			}

			var totalCPU float32
			var totalMemoryMiB float32
			var startedCount float32

			for _, box := range boxes {
				if box.Running {
					totalCPU += float32(box.CPUs)
					totalMemoryMiB += float32(box.MemoryMiB)
					startedCount++
				}
			}

			c.resourcesMutex.Lock()
			c.allocatedCPU = totalCPU
			c.allocatedMemoryGiB = totalMemoryMiB / 1024
			c.startedSandboxCount = startedCount
			c.resourcesMutex.Unlock()
		}
	}
}
