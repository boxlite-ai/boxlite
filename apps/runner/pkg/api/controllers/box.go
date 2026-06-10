// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"net/http"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

// Create 			godoc
//
//	@Tags			box
//	@Summary		Create a box
//	@Description	Create a box
//	@Param			box	body	dto.CreateBoxDTO	true	"Create box"
//	@Produce		json
//	@Success		201	{object}	dto.StartBoxResponse
//	@Failure		400	{object}	common_errors.ErrorResponse
//	@Failure		401	{object}	common_errors.ErrorResponse
//	@Failure		404	{object}	common_errors.ErrorResponse
//	@Failure		409	{object}	common_errors.ErrorResponse
//	@Failure		500	{object}	common_errors.ErrorResponse
//	@Router			/boxes [post]
//
//	@id				Create
func Create(ctx *gin.Context) {
	var createBoxDto dto.CreateBoxDTO
	err := ctx.ShouldBindJSON(&createBoxDto)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	_, daemonVersion, err := runner.Boxlite.Create(ctx.Request.Context(), createBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		ctx.Error(err)
		return
	}

	common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusSuccess)).Inc()

	ctx.JSON(http.StatusCreated, dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	})
}

// Destroy 			godoc
//
//	@Tags			box
//	@Summary		Destroy box
//	@Description	Destroy box
//	@Produce		json
//	@Param			boxId	path		string	true	"Box ID"
//	@Success		200			{string}	string	"Box destroyed"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/destroy [post]
//
//	@id				Destroy
func Destroy(ctx *gin.Context) {
	boxId := ctx.Param("boxId")

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runner.Boxlite.Destroy(ctx.Request.Context(), boxId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		ctx.Error(err)
		return
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	ctx.JSON(http.StatusOK, "Box destroyed")
}

// Resize 			godoc
//
//	@Tags			box
//	@Summary		Resize box
//	@Description	Resize box
//	@Produce		json
//	@Param			boxId	path		string					true	"Box ID"
//	@Param			box		body		dto.ResizeBoxDTO	true	"Resize box"
//	@Success		200			{string}	string					"Box resized"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/resize [post]
//
//	@id				Resize
func Resize(ctx *gin.Context) {
	var resizeDto dto.ResizeBoxDTO
	err := ctx.ShouldBindJSON(&resizeDto)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	boxId := ctx.Param("boxId")

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runner.Boxlite.Resize(ctx.Request.Context(), boxId, resizeDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("resize", string(common.PrometheusOperationStatusFailure)).Inc()
		ctx.Error(err)
		return
	}

	common.ContainerOperationCount.WithLabelValues("resize", string(common.PrometheusOperationStatusSuccess)).Inc()

	ctx.JSON(http.StatusOK, "Box resized")
}

// UpdateNetworkSettings godoc
//
//	@Tags			box
//	@Summary		Update box network settings
//	@Description	Update box network settings
//	@Produce		json
//	@Param			boxId	path		string							true	"Box ID"
//	@Param			box		body		dto.UpdateNetworkSettingsDTO	true	"Update network settings"
//	@Success		200			{string}	string							"Network settings updated"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/network-settings [post]
//
//	@id				UpdateNetworkSettings
func UpdateNetworkSettings(ctx *gin.Context) {
	var updateNetworkSettingsDto dto.UpdateNetworkSettingsDTO
	err := ctx.ShouldBindJSON(&updateNetworkSettingsDto)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	boxId := ctx.Param("boxId")
	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runner.Boxlite.UpdateNetworkSettings(ctx.Request.Context(), boxId, updateNetworkSettingsDto)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, "Network settings updated")
}

// GetNetworkSettings godoc
//
//	@Tags			box
//	@Summary		Get box network settings
//	@Description	Get box network settings
//	@Produce		json
//	@Param			boxId	path		string							true	"Box ID"
//	@Success		200			{object}	dto.UpdateNetworkSettingsDTO	"Network settings"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/network-settings [get]
//
//	@id				GetNetworkSettings
func GetNetworkSettings(ctx *gin.Context) {
	// TODO: Implement GetNetworkSettings in Docker client
	// boxId := ctx.Param("boxId")
	// runner := runner.GetInstance(nil)
	// networkSettings, err := runner.Boxlite.GetNetworkSettings(ctx.Request.Context(), boxId)
	// if err != nil {
	// 	ctx.Error(err)
	// 	return
	// }

	// For now, return empty settings
	networkSettings := dto.UpdateNetworkSettingsDTO{
		NetworkBlockAll:  nil,
		NetworkAllowList: nil,
	}

	ctx.JSON(http.StatusOK, networkSettings)
}

// Start 			godoc
//
//	@Tags			box
//	@Summary		Start box
//	@Description	Start box
//	@Produce		json
//	@Param			boxId	path		string						true	"Box ID"
//	@Param			metadata	body		object						false	"Metadata"
//	@Param			token		query		string						false	"Auth token"
//	@Success		200			{object}	dto.StartBoxResponse	"Box started"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/start [post]
//
//	@id				Start
func Start(ctx *gin.Context) {
	boxId := ctx.Param("boxId")

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	var metadata map[string]string
	err = ctx.ShouldBindJSON(&metadata)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	var authToken *string
	tokenQuery := ctx.Query("token")
	if tokenQuery != "" {
		authToken = &tokenQuery
	}

	daemonVersion, err := runner.Boxlite.Start(ctx.Request.Context(), boxId, authToken, metadata)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	})
}

// Stop 			godoc
//
//	@Tags			box
//	@Summary		Stop box
//	@Description	Stop box
//	@Produce		json
//	@Param			boxId	path		string				true	"Box ID"
//	@Param			box		body		dto.StopBoxDTO	false	"Stop box"
//	@Success		200			{string}	string				"Box stopped"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/stop [post]
//
//	@id				Stop
func Stop(ctx *gin.Context) {
	boxId := ctx.Param("boxId")

	var stopDto dto.StopBoxDTO
	// Allow empty body for backwards compatibility
	_ = ctx.ShouldBindJSON(&stopDto)

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runner.Boxlite.Stop(ctx.Request.Context(), boxId, stopDto.Force)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, "Box stopped")
}

// Info godoc
//
//	@Tags			box
//	@Summary		Get box info
//	@Description	Get box info
//	@Produce		json
//	@Param			boxId	path		string				true	"Box ID"
//	@Success		200			{object}	BoxInfoResponse	"Box info"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId} [get]
//
//	@id				Info
func Info(ctx *gin.Context) {
	boxId := ctx.Param("boxId")

	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	info, err := runner.BoxService.GetBoxInfo(ctx.Request.Context(), boxId)
	if err != nil {
		ctx.Error(err)
		return
	}

	var daemonVersion *string
	if info.BoxState == enums.BoxStateStarted {
		daemonVersionStr, err := runner.Boxlite.GetDaemonVersion(ctx.Request.Context(), boxId)
		if err == nil {
			daemonVersion = &daemonVersionStr
		}
	}

	ctx.JSON(http.StatusOK, BoxInfoResponse{
		State:         info.BoxState,
		DaemonVersion: daemonVersion,
	})
}

type BoxInfoResponse struct {
	State         enums.BoxState `json:"state"`
	DaemonVersion *string        `json:"daemonVersion,omitempty"`
} //	@name	BoxInfoResponse

// Recover godoc
//
//	@Summary		Recover box from error state
//	@Description	Recover box from error state using specified recovery type
//	@Tags			box
//	@Accept			json
//	@Produce		json
//	@Param			boxId	path		string					true	"Box ID"
//	@Param			recovery	body		dto.RecoverBoxDTO	true	"Recovery parameters"
//	@Success		200			{string}	string					"Box recovered"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/recover [post]
//
//	@id				Recover
func Recover(ctx *gin.Context) {
	var recoverDto dto.RecoverBoxDTO
	err := ctx.ShouldBindJSON(&recoverDto)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	boxId := ctx.Param("boxId")
	runner, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runner.Boxlite.RecoverBox(ctx.Request.Context(), boxId, recoverDto)
	if err != nil {
		ctx.Error(err)
		return
	}

	ctx.JSON(http.StatusOK, "Box recovered")
}

// IsRecoverable godoc
//
//	@Summary		Check if box error is recoverable
//	@Description	Check if the box's error reason indicates a recoverable error
//	@Tags			box
//	@Accept			json
//	@Produce		json
//	@Param			boxId	path		string					true	"Box ID"
//	@Param			request		body		dto.IsRecoverableDTO	true	"Error reason to check"
//	@Success		200			{object}	dto.IsRecoverableResponse
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/is-recoverable [post]
//
//	@id				IsRecoverable
func IsRecoverable(ctx *gin.Context) {
	var request dto.IsRecoverableDTO
	if err := ctx.ShouldBindJSON(&request); err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}

	recoverable := common.IsRecoverable(request.ErrorReason)

	ctx.JSON(http.StatusOK, dto.IsRecoverableResponse{
		Recoverable: recoverable,
	})
}
