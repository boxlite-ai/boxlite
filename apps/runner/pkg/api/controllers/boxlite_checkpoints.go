// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"

	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// CheckpointTransferHandler is shared by the authenticated internal routes and
// loopback contract tests; production obtains the same service used by jobs.
func CheckpointTransferHandler(service *blclient.CheckpointService) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		current := service
		if current == nil {
			r, e := runner.GetInstance(nil)
			if e != nil {
				respondError(ctx, 500, "runner unavailable", "InternalError", "internal")
				return
			}
			current = r.Boxlite.Checkpoints()
		}
		id := ctx.Param("transferId")
		var err error
		switch {
		case ctx.Request.Method == http.MethodDelete:
			err = current.Delete(ctx.Request.Context(), id)
			if err == nil {
				ctx.Status(http.StatusNoContent)
				return
			}
		case ctx.FullPath() == "/api/checkpoint-transfers/:transferId/register":
			var request blclient.CheckpointRegistration
			if err = decodeCheckpointRequest(ctx, &request); err != nil {
				return
			}
			var nativeID string
			nativeID, err = current.Register(ctx.Request.Context(), id, request)
			if err == nil {
				ctx.JSON(http.StatusOK, gin.H{"checkpointId": nativeID})
				return
			}
		case ctx.FullPath() == "/api/checkpoint-transfers/:transferId/export":
			var request struct {
				BoxID          string `json:"boxId"`
				OperationID    string `json:"operationId"`
				OrganizationID string `json:"organizationId"`
			}
			if err = decodeCheckpointRequest(ctx, &request); err != nil {
				return
			}
			ctx.Header("Content-Type", "application/octet-stream")
			err = current.Export(ctx.Request.Context(), id, request.BoxID, request.OrganizationID, request.OperationID, ctx.Writer)
			if err == nil {
				return
			}
			if ctx.Writer.Written() {
				panic(http.ErrAbortHandler)
			}
			ctx.Writer.Header().Del("Content-Type")
		default:
			contentType, _, parseErr := mime.ParseMediaType(ctx.ContentType())
			if parseErr != nil || contentType != "application/octet-stream" {
				respondError(ctx, 400, "application/octet-stream is required", "InvalidArgumentError", "invalid_argument")
				return
			}
			var inspection any
			inspection, err = current.Stage(ctx.Request.Context(), id, ctx.GetHeader("X-Organization-Id"), ctx.Request.Body)
			if err == nil {
				ctx.JSON(http.StatusOK, inspection)
				return
			}
		}
		respondCopyError(ctx, err)
	}
}

func decodeCheckpointRequest(ctx *gin.Context, destination any) error {
	decoder := json.NewDecoder(io.LimitReader(ctx.Request.Body, 65537))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(destination)
	if err == nil {
		var tail any
		if trailing := decoder.Decode(&tail); !errors.Is(trailing, io.EOF) {
			err = errors.New("trailing checkpoint request data")
		}
	}
	if err != nil {
		respondError(ctx, 400, "invalid checkpoint request", "InvalidArgumentError", "invalid_argument")
	}
	return err
}
