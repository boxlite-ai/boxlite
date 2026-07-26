// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/boxlite-ai/runner/pkg/models/enums"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

type legacyCreateBoxRequest struct {
	dto.CreateBoxDTO
	Advanced json.RawMessage `json:"advanced"`
	// Retain fail-closed detection for requests produced by the short-lived
	// flat capability contract during mixed-version rollouts.
	CapAdd       json.RawMessage `json:"capAdd"`
	CapDrop      json.RawMessage `json:"capDrop"`
	CapAddSnake  json.RawMessage `json:"cap_add"`
	CapDropSnake json.RawMessage `json:"cap_drop"`
}

type legacyRecoverBoxRequest struct {
	dto.RecoverBoxDTO
	Advanced json.RawMessage `json:"advanced"`
	// Retain fail-closed detection for requests produced by the short-lived
	// flat capability contract during mixed-version rollouts.
	CapAdd       json.RawMessage `json:"capAdd"`
	CapDrop      json.RawMessage `json:"capDrop"`
	CapAddSnake  json.RawMessage `json:"cap_add"`
	CapDropSnake json.RawMessage `json:"cap_drop"`
}

func hasCapabilityPolicyFields(fields ...json.RawMessage) bool {
	for _, field := range fields {
		if field != nil {
			return true
		}
	}
	return false
}

func bindStrictJSON(ctx *gin.Context, target any) error {
	decoder := json.NewDecoder(ctx.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain a single JSON object")
		}
		return err
	}

	if binding.Validator == nil {
		return nil
	}
	return binding.Validator.ValidateStruct(target)
}

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
	var request legacyCreateBoxRequest
	err := ctx.ShouldBindJSON(&request)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}
	if hasCapabilityPolicyFields(
		request.Advanced,
		request.CapAdd,
		request.CapDrop,
		request.CapAddSnake,
		request.CapDropSnake,
	) {
		ctx.Error(common_errors.NewInvalidBodyRequestError(errors.New("advanced capability policy requires POST /boxes/strict")))
		return
	}
	createBox(ctx, request.CreateBoxDTO)
}

// CreateWithCapabilities godoc
//
//	@Tags			box
//	@Summary		Create a box with a capability policy
//	@Description	Fail-closed create contract for capability-bearing requests
//	@Param			box	body	dto.CreateBoxWithCapabilitiesDTO	true	"Create box with capabilities"
//	@Produce		json
//	@Success		201	{object}	dto.StartBoxResponse
//	@Failure		400	{object}	common_errors.ErrorResponse
//	@Failure		401	{object}	common_errors.ErrorResponse
//	@Failure		404	{object}	common_errors.ErrorResponse
//	@Failure		409	{object}	common_errors.ErrorResponse
//	@Failure		500	{object}	common_errors.ErrorResponse
//	@Router			/boxes/strict [post]
//
//	@id				CreateWithCapabilities
func CreateWithCapabilities(ctx *gin.Context) {
	var request dto.CreateBoxWithCapabilitiesDTO
	if err := bindStrictJSON(ctx, &request); err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}
	if !request.HasCapabilityPolicy() {
		ctx.Error(common_errors.NewInvalidBodyRequestError(errors.New("advanced.capabilities.add or advanced.capabilities.drop is required")))
		return
	}
	createBox(ctx, request.AsCreateBoxDTO())
}

func createBox(ctx *gin.Context, createBoxDto dto.CreateBoxDTO) {
	runnerInstance, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	_, daemonVersion, err := runnerInstance.Boxlite.Create(ctx.Request.Context(), createBoxDto)
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
	var request legacyRecoverBoxRequest
	err := ctx.ShouldBindJSON(&request)
	if err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}
	if hasCapabilityPolicyFields(
		request.Advanced,
		request.CapAdd,
		request.CapDrop,
		request.CapAddSnake,
		request.CapDropSnake,
	) {
		ctx.Error(common_errors.NewInvalidBodyRequestError(errors.New("advanced capability policy requires the strict recovery endpoint")))
		return
	}
	recoverBox(ctx, request.RecoverBoxDTO)
}

// RecoverWithCapabilities godoc
//
//	@Summary		Recover a box with a capability policy
//	@Description	Fail-closed recovery contract for capability-bearing requests
//	@Tags			box
//	@Accept			json
//	@Produce		json
//	@Param			boxId		path		string								true	"Box ID"
//	@Param			recovery	body		dto.RecoverBoxWithCapabilitiesDTO	true	"Recovery parameters with capabilities"
//	@Success		200			{string}	string								"Box recovered"
//	@Failure		400			{object}	common_errors.ErrorResponse
//	@Failure		401			{object}	common_errors.ErrorResponse
//	@Failure		404			{object}	common_errors.ErrorResponse
//	@Failure		409			{object}	common_errors.ErrorResponse
//	@Failure		500			{object}	common_errors.ErrorResponse
//	@Router			/boxes/{boxId}/recover/strict [post]
//
//	@id				RecoverWithCapabilities
func RecoverWithCapabilities(ctx *gin.Context) {
	var request dto.RecoverBoxWithCapabilitiesDTO
	if err := bindStrictJSON(ctx, &request); err != nil {
		ctx.Error(common_errors.NewInvalidBodyRequestError(err))
		return
	}
	if !request.HasCapabilityPolicy() {
		ctx.Error(common_errors.NewInvalidBodyRequestError(errors.New("advanced.capabilities.add or advanced.capabilities.drop is required")))
		return
	}
	recoverBox(ctx, request.AsRecoverBoxDTO())
}

func recoverBox(ctx *gin.Context, recoverDto dto.RecoverBoxDTO) {
	boxId := ctx.Param("boxId")
	runnerInstance, err := runner.GetInstance(nil)
	if err != nil {
		ctx.Error(err)
		return
	}

	err = runnerInstance.Boxlite.RecoverBox(ctx.Request.Context(), boxId, recoverDto)
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
