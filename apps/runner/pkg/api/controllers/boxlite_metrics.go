package controllers

import (
	"fmt"
	"net/http"

	"github.com/boxlite-labs/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

type BoxMetricsResponse struct {
	CPUPercent       float64 `json:"cpu_percent"`
	MemoryBytes      int64   `json:"memory_bytes"`
	CommandsExecuted int     `json:"commands_executed_total"`
	ExecErrors       int     `json:"exec_errors_total"`
	BytesSent        int64   `json:"bytes_sent_total"`
	BytesReceived    int64   `json:"bytes_received_total"`
	CreateDurationMs int64   `json:"create_duration_ms,omitempty"`
	BootDurationMs   int64   `json:"boot_duration_ms,omitempty"`
	NetworkBytesSent int64   `json:"network_bytes_sent,omitempty"`
	NetworkBytesRecv int64   `json:"network_bytes_received,omitempty"`
	NetworkTCPConns  int     `json:"network_tcp_connections,omitempty"`
	NetworkTCPErrors int     `json:"network_tcp_errors,omitempty"`
}

func BoxliteMetrics(ctx *gin.Context) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	boxId := ctx.Param("boxId")

	metrics, err := r.Boxlite.BoxMetrics(ctx.Request.Context(), boxId)
	if err != nil {
		ctx.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("metrics failed: %s", err)})
		return
	}

	ctx.JSON(http.StatusOK, BoxMetricsResponse{
		CPUPercent:       metrics.CPUPercent,
		MemoryBytes:      metrics.MemoryBytes,
		CommandsExecuted: metrics.CommandsExecuted,
		ExecErrors:       metrics.ExecErrors,
		BytesSent:        metrics.BytesSent,
		BytesReceived:    metrics.BytesReceived,
		CreateDurationMs: metrics.CreateDurationMs,
		BootDurationMs:   metrics.BootDurationMs,
		NetworkBytesSent: metrics.NetworkBytesSent,
		NetworkBytesRecv: metrics.NetworkBytesReceived,
		NetworkTCPConns:  metrics.NetworkTCPConns,
		NetworkTCPErrors: metrics.NetworkTCPErrors,
	})
}
