// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"context"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

// TagImage godoc
//
//	@Tags			artifacts
//	@Summary		Tag an image
//	@Deprecated		New artifact tags are sent in PullArtifact
//	@Description	Tag an existing local image with a new target reference
//	@Param			request	body		dto.TagImageRequestDTO	true	"Tag image request"
//	@Success		200		{string}	string					"Image successfully tagged"
//	@Failure		400		{object}	common_errors.ErrorResponse
//	@Failure		401		{object}	common_errors.ErrorResponse
//	@Failure		404		{object}	common_errors.ErrorResponse
//	@Failure		409		{object}	common_errors.ErrorResponse
//	@Failure		500		{object}	common_errors.ErrorResponse
//
//	@Router			/artifacts/tag [post]
//
//	@id				TagImage
func TagImage(ctx *gin.Context) {
	var request dto.TagImageRequestDTO
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	exists, err := runner.Boxlite.ImageExists(ctx.Request.Context(), request.SourceImage)
	if err != nil {
		ctx.Error(err)
		return
	}

	if !exists {
		ctx.Error(common_errors.NewNotFoundError(fmt.Errorf("source image not found: %s", request.SourceImage)))
		return
	}

	if !strings.Contains(request.TargetImage, ":") || strings.HasSuffix(request.TargetImage, ":") {
		ctx.Error(common_errors.NewBadRequestError(errors.New("targetImage must include a valid tag")))
		return
	}

	if err := runner.Boxlite.TagImage(ctx.Request.Context(), request.SourceImage, request.TargetImage); err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, "Image tagged successfully")
}

// PullArtifact godoc
//
//	@Tags			artifacts
//	@Summary		Pull an artifact
//	@Description	Pull an artifact from a registry and optionally push to another registry. The operation runs asynchronously and returns 202 immediately.
//	@Param			request	body		dto.PullArtifactRequestDTO	true	"Pull artifact"
//	@Success		202		{string}	string						"Artifact pull started"
//	@Failure		400		{object}	common_errors.ErrorResponse
//	@Failure		401		{object}	common_errors.ErrorResponse
//	@Failure		404		{object}	common_errors.ErrorResponse
//	@Failure		409		{object}	common_errors.ErrorResponse
//	@Failure		500		{object}	common_errors.ErrorResponse
//
//	@Router			/artifacts/pull [post]
//
//	@id				PullArtifact
func PullArtifact(generalCtx context.Context, logger *slog.Logger) func(ctx *gin.Context) {
	return func(ctx *gin.Context) {
		var request dto.PullArtifactRequestDTO
		err := ctx.ShouldBindJSON(&request)
		if err != nil {
			ctx.Error(common_errors.NewInvalidBodyRequestError(err))
			return
		}

		runner, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Error(err)
			return
		}

		cacheKey := request.ArtifactRef
		if request.DestinationRef != nil {
			cacheKey = *request.DestinationRef
		}

		err = runner.ArtifactErrorCache.RemoveError(generalCtx, cacheKey)
		if err != nil {
			logger.ErrorContext(generalCtx, "Failed to remove artifact error cache entry", "cacheKey", cacheKey, "error", err)
		}

		go func() {
			err := runner.Boxlite.PullArtifact(generalCtx, request)
			if err != nil {
				logger.DebugContext(generalCtx, "Pull artifact failed", "cacheKey", cacheKey, "error", err)
				err = runner.ArtifactErrorCache.SetError(generalCtx, cacheKey, err.Error())
				if err != nil {
					logger.ErrorContext(generalCtx, "Failed to set artifact error cache entry", "cacheKey", cacheKey, "error", err)
				}
			} else {
				err = runner.ArtifactErrorCache.RemoveError(generalCtx, cacheKey)
				if err != nil {
					logger.ErrorContext(generalCtx, "Failed to remove artifact error cache entry", "cacheKey", cacheKey, "error", err)
				}
			}
		}()

		ctx.JSON(http.StatusAccepted, "Artifact pull started")
	}
}

// BuildArtifact godoc
//
//	@Tags			artifacts
//	@Summary		Build an artifact
//	@Description	Build an artifact from a Dockerfile and context hashes. The operation runs asynchronously and returns 202 immediately.
//	@Param			request	body		dto.BuildArtifactRequestDTO	true	"Build artifact request"
//	@Success		202		{string}	string						"Artifact build started"
//	@Failure		400		{object}	common_errors.ErrorResponse
//	@Failure		401		{object}	common_errors.ErrorResponse
//	@Failure		404		{object}	common_errors.ErrorResponse
//	@Failure		409		{object}	common_errors.ErrorResponse
//	@Failure		500		{object}	common_errors.ErrorResponse
//
//	@Router			/artifacts/build [post]
//
//	@id				BuildArtifact
func BuildArtifact(generalCtx context.Context, logger *slog.Logger) func(ctx *gin.Context) {
	return func(ctx *gin.Context) {
		var request dto.BuildArtifactRequestDTO
		err := ctx.ShouldBindJSON(&request)
		if err != nil {
			ctx.Error(common_errors.NewInvalidBodyRequestError(err))
			return
		}

		if !strings.Contains(request.ArtifactRef, ":") || strings.HasSuffix(request.ArtifactRef, ":") {
			ctx.Error(common_errors.NewBadRequestError(errors.New("artifact ref must include a valid tag")))
			return
		}

		runner, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Error(err)
			return
		}

		err = runner.ArtifactErrorCache.RemoveError(generalCtx, request.ArtifactRef)
		if err != nil {
			logger.ErrorContext(generalCtx, "Failed to remove artifact error cache entry", "cacheKey", request.ArtifactRef, "error", err)
		}

		go func() {
			err := runner.Boxlite.BuildArtifact(generalCtx, request)
			if err != nil {
				logger.DebugContext(generalCtx, "Build artifact failed", "cacheKey", request.ArtifactRef, "error", err)
				err = runner.ArtifactErrorCache.SetError(generalCtx, request.ArtifactRef, err.Error())
				if err != nil {
					logger.ErrorContext(generalCtx, "Failed to set artifact error cache entry", "cacheKey", request.ArtifactRef, "error", err)
				}
			} else {
				err = runner.ArtifactErrorCache.RemoveError(generalCtx, request.ArtifactRef)
				if err != nil {
					logger.ErrorContext(generalCtx, "Failed to remove artifact error cache entry", "cacheKey", request.ArtifactRef, "error", err)
				}
			}
		}()

		ctx.JSON(http.StatusAccepted, "Artifact build started")
	}
}

// ArtifactExists godoc
//
//	@Tags			artifacts
//	@Summary		Check if an artifact exists
//	@Description	Check if a specified artifact exists locally
//	@Produce		json
//	@Param			artifactRef	query		string	true	"Artifact ref"	example:"nginx:latest"
//	@Success		200			{object}	ArtifactExistsResponse
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/artifacts/exists [get]
//
//	@id				ArtifactExists
func ArtifactExists(ctx *gin.Context) {
	artifactRef := ctx.Query("artifactRef")
	if artifactRef == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("artifactRef parameter is required")))
		return
	}

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	exists, err := runner.Boxlite.ImageExists(ctx.Request.Context(), artifactRef)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, ArtifactExistsResponse{
		Exists: exists,
	})
}

// RemoveArtifact godoc
//
//	@Tags			artifacts
//	@Summary		Remove an artifact
//	@Description	Remove a specified artifact from the local system
//	@Produce		json
//	@Param			artifactRef	query		string	true	"Artifact ref"	example:"nginx:latest"
//	@Success		200			{string}	string	"Artifact successfully removed"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/artifacts/remove [post]
//
//	@id				RemoveArtifact
func RemoveArtifact(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		artifactRef := ctx.Query("artifactRef")
		if artifactRef == "" {
			ctx.Error(common_errors.NewBadRequestError(errors.New("artifactRef parameter is required")))
			return
		}

		runner, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Error(err)
			return
		}

		err = runner.Boxlite.RemoveImage(ctx.Request.Context(), artifactRef, true)
		if err != nil {
			ctx.Error(err)
			return
		}

		err = runner.ArtifactErrorCache.RemoveError(ctx.Request.Context(), artifactRef)
		if err != nil {
			logger.ErrorContext(ctx.Request.Context(), "Failed to remove artifact error cache entry", "cacheKey", artifactRef, "error", err)
		}

		ctx.JSON(http.StatusOK, "Artifact removed successfully")
	}
}

type ArtifactExistsResponse struct {
	Exists bool `json:"exists" example:"true"`
} //	@name	ArtifactExistsResponse

// GetBuildLogs godoc
//
//	@Tags			artifacts
//	@Summary		Get build logs
//	@Description	Stream build logs
//	@Param			artifactRef	query		string	true	"Runtime artifact ref"
//	@Param			follow		query		boolean	false	"Whether to follow the log output"
//	@Success		200			{string}	string	"Build logs stream"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//
//	@Router			/artifacts/logs [get]
//
//	@id				GetBuildLogs
func GetBuildLogs(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		reqCtx := ctx.Request.Context()
		artifactRef := ctx.Query("artifactRef")
		if artifactRef == "" {
			ctx.Error(common_errors.NewBadRequestError(errors.New("artifactRef parameter is required")))
			return
		}

		follow := ctx.Query("follow") == "true"

		logFilePath, err := config.GetBuildLogFilePath(artifactRef)
		if err != nil {
			ctx.Error(common_errors.NewCustomError(http.StatusInternalServerError, err.Error(), "INTERNAL_SERVER_ERROR"))
			return
		}

		if _, err := os.Stat(logFilePath); os.IsNotExist(err) {
			ctx.Error(common_errors.NewNotFoundError(fmt.Errorf("build logs not found for ref: %s", artifactRef)))
			return
		}

		ctx.Header("Content-Type", "application/octet-stream")

		file, err := os.Open(logFilePath)
		if err != nil {
			ctx.Error(common_errors.NewCustomError(http.StatusInternalServerError, err.Error(), "INTERNAL_SERVER_ERROR"))
			return
		}
		defer file.Close()

		// If not following, just return the entire file content
		if !follow {
			_, err = io.Copy(ctx.Writer, file)
			if err != nil {
				ctx.Error(common_errors.NewCustomError(http.StatusInternalServerError, err.Error(), "INTERNAL_SERVER_ERROR"))
			}
			return
		}

		reader := bufio.NewReader(file)
		runner, err := runner.GetInstance(nil)
		if err != nil {
			ctx.Error(err)
			return
		}

		checkArtifactRef := artifactRef

		// Fixed tag for instances where we are not looking for an entry with an artifact ID.
		if strings.HasPrefix(artifactRef, "boxlite") {
			checkArtifactRef = artifactRef + ":boxlite"
		}

		flusher, ok := ctx.Writer.(http.Flusher)
		if !ok {
			ctx.Error(common_errors.NewCustomError(http.StatusInternalServerError, "Streaming not supported", "STREAMING_NOT_SUPPORTED"))
			return
		}

		go func() {
			for {
				line, err := reader.ReadBytes('\n')
				if err != nil && err != io.EOF {
					logger.ErrorContext(reqCtx, "Error reading log file", "error", err)
					break
				}

				if len(line) > 0 {
					_, writeErr := ctx.Writer.Write(line)
					if writeErr != nil {
						logger.ErrorContext(reqCtx, "Error writing to response", "error", writeErr)
						break
					}
					flusher.Flush()
				}
			}
		}()

		for {
			exists, err := runner.Boxlite.ImageExists(ctx.Request.Context(), checkArtifactRef)
			if err != nil {
				logger.ErrorContext(reqCtx, "Error checking build status", "error", err)
				break
			}

			if exists {
				// If artifact exists, build is complete, allow time for the last logs to be written and break the loop
				time.Sleep(1 * time.Second)
				break
			}

			time.Sleep(250 * time.Millisecond)
		}
	}
}

// GetArtifactInfo godoc
//
//	@Tags			artifacts
//	@Summary		Get artifact information
//	@Description	Get information about a specified artifact including size and entrypoint. Returns 422 if the last pull/build operation failed, with the error reason in the message.
//	@Produce		json
//	@Param			artifactRef	query		string	true	"Artifact ref"	example:"nginx:latest"
//	@Success		200			{object}	dto.ArtifactInfoResponse
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		422			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/artifacts/info [get]
//
//	@id				GetArtifactInfo
func GetArtifactInfo(ctx *gin.Context) {
	artifactRef := ctx.Query("artifactRef")
	if artifactRef == "" {
		ctx.Error(common_errors.NewBadRequestError(errors.New("artifactRef parameter is required")))
		return
	}

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	exists, err := runner.Boxlite.ImageExists(ctx.Request.Context(), artifactRef)
	if err != nil {
		ctx.Error(err)
		return
	}

	if !exists {
		errReason, err := runner.ArtifactErrorCache.GetError(ctx.Request.Context(), artifactRef)
		if err == nil && errReason != nil {
			ctx.Error(common_errors.NewUnprocessableEntityError(errors.New(*errReason)))
			return
		}
		ctx.Error(common_errors.NewNotFoundError(fmt.Errorf("artifact not found: %s", artifactRef)))
		return
	}

	info, err := runner.Boxlite.GetImageInfo(ctx.Request.Context(), artifactRef)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, dto.ArtifactInfoResponse{
		Name:       artifactRef,
		SizeGB:     float64(info.Size) / (1024 * 1024 * 1024), // Convert bytes to GB
		Entrypoint: info.Entrypoint,
		Cmd:        info.Cmd,
		Hash:       dto.HashWithoutPrefix(info.Hash),
	})
}

// InspectArtifactInRegistry godoc
//
//	@Tags			artifacts
//	@Summary		Inspect an artifact in a registry
//	@Description	Inspect a specified artifact in a registry
//	@Produce		json
//	@Param			request	body		dto.InspectArtifactInRegistryRequestDTO	true	"Inspect artifact in registry request"
//	@Success		200		{object}	dto.ArtifactDigestResponse
//	@Failure		400		{object}	common_errors.ErrorResponse
//	@Failure		401		{object}	common_errors.ErrorResponse
//	@Failure		404		{object}	common_errors.ErrorResponse
//	@Failure		500		{object}	common_errors.ErrorResponse
//
//	@Router			/artifacts/inspect [post]
//	@id				InspectArtifactInRegistry
func InspectArtifactInRegistry(ctx *gin.Context) {
	var request dto.InspectArtifactInRegistryRequestDTO
	err := ctx.ShouldBindJSON(&request)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	digest, err := runner.Boxlite.InspectImageInRegistry(ctx.Request.Context(), request.ArtifactRef, request.Registry)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, dto.ArtifactDigestResponse{
		Hash:   dto.HashWithoutPrefix(digest.Digest),
		SizeGB: float64(digest.Size) / (1024 * 1024 * 1024),
	})
}
