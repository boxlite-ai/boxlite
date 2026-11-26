// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package common

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

type PrometheusOperationStatus string

const (
	PrometheusOperationStatusSuccess PrometheusOperationStatus = "success"
	PrometheusOperationStatusFailure PrometheusOperationStatus = "failure"
)

// Define your metrics
var (
	// Histogram to track duration of container operations
	ContainerOperationDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "container_operation_duration_seconds",
			Help: "Time taken for container operations in seconds",
			// Buckets optimized for detecting anomalies in operation durations
			Buckets: []float64{0.1, 0.25, 0.5, 0.75, 1, 2, 3, 5, 7.5, 10, 15, 30, 60, 120, 300},
		},
		[]string{"operation"},
	)

	// Counter to track occurrence of container operations with status
	ContainerOperationCount = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "container_operation_total",
			Help: "Total number of container operations",
		},
		[]string{"operation", "status"},
	)

	// Exec attach WebSocket sessions this runner has ended, by end reason.
	// The label values are the attachEndReason constants in
	// pkg/api/controllers. A healthy runner only adds to exec_done and
	// client_close; pong_timeout means a client held the socket but stopped
	// answering pings for 45 seconds.
	ExecAttachSessions = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "exec_attach_sessions_total",
			Help: "Exec attach WebSocket sessions ended by this runner, by end reason",
		},
		[]string{"reason"},
	)

	// Exec attach requests this runner refused with 409, by refusal reason.
	// A client that reconnects while its previous session still holds the
	// single attach slot lands in slot_occupied.
	ExecAttachRefusals = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "exec_attach_refusals_total",
			Help: "Exec attach requests refused by this runner, by refusal reason",
		},
		[]string{"reason"},
	)
)
