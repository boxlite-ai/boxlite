/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/containerd/errdefs"
	"github.com/go-playground/validator/v10"
)

var strictPayloadValidator = newStrictPayloadValidator()

func newStrictPayloadValidator() *validator.Validate {
	validate := validator.New(validator.WithRequiredStructEnabled())
	validate.SetTagName("validate")
	_ = validate.RegisterValidation("optional", func(validator.FieldLevel) bool {
		return true
	}, true)
	return validate
}

func rejectLegacyCapabilityFields(payload *string, strictJobType apiclient.JobType) error {
	if payload == nil || *payload == "" {
		return nil
	}

	var wireFields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(*payload), &wireFields); err != nil {
		return nil
	}
	for field := range wireFields {
		if strings.EqualFold(field, "advanced") ||
			strings.EqualFold(field, "capAdd") ||
			strings.EqualFold(field, "capDrop") ||
			strings.EqualFold(field, "cap_add") ||
			strings.EqualFold(field, "cap_drop") {
			return fmt.Errorf("advanced capability policy requires %s job", strictJobType)
		}
	}
	return nil
}

func parseStrictPayload(payload *string, target any) error {
	if payload == nil || *payload == "" {
		return fmt.Errorf("payload is required")
	}

	decoder := json.NewDecoder(strings.NewReader(*payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("payload must contain a single JSON object")
		}
		return err
	}
	if err := strictPayloadValidator.Struct(target); err != nil {
		return fmt.Errorf("validate payload: %w", err)
	}
	return nil
}

func (e *Executor) createBox(ctx context.Context, job *apiclient.Job) (any, error) {
	if err := rejectLegacyCapabilityFields(job.Payload, apiclient.JOBTYPE_CREATE_BOX_WITH_CAPABILITIES_V2); err != nil {
		return nil, err
	}
	var createBoxDto dto.CreateBoxDTO
	err := e.parsePayload(job.Payload, &createBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	return e.executeCreateBox(ctx, createBoxDto)
}

func (e *Executor) createBoxWithCapabilities(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.CreateBoxWithCapabilitiesDTO
	if err := parseStrictPayload(job.Payload, &request); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if !request.HasCapabilityPolicy() {
		return nil, fmt.Errorf("capability create job requires advanced.capabilities.add or advanced.capabilities.drop")
	}
	return e.executeCreateBox(ctx, request.AsCreateBoxDTO())
}

func (e *Executor) executeCreateBox(ctx context.Context, createBoxDto dto.CreateBoxDTO) (any, error) {
	_, daemonVersion, err := e.backend.Create(ctx, createBoxDto)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("create", string(common.PrometheusOperationStatusSuccess)).Inc()

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) startBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload StartBoxPayload
	err := e.parsePayload(job.Payload, &payload)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	daemonVersion, err := e.backend.Start(ctx, job.ResourceId, payload.AuthToken, payload.Metadata)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return dto.StartBoxResponse{
		DaemonVersion: daemonVersion,
	}, nil
}

func (e *Executor) stopBox(ctx context.Context, job *apiclient.Job) (any, error) {
	var payload dto.StopBoxDTO
	if job.Payload != nil {
		_ = e.parsePayload(job.Payload, &payload)
	}

	err := e.backend.Stop(ctx, job.ResourceId, payload.Force)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return nil, nil
}

func (e *Executor) destroyBox(ctx context.Context, job *apiclient.Job) (any, error) {
	err := e.backend.Destroy(ctx, job.ResourceId)
	if err != nil {
		common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusFailure)).Inc()
		return nil, common.FormatRecoverableError(err)
	}

	common.ContainerOperationCount.WithLabelValues("destroy", string(common.PrometheusOperationStatusSuccess)).Inc()

	return nil, nil
}

func (e *Executor) updateNetworkSettings(ctx context.Context, job *apiclient.Job) (any, error) {
	var updateNetworkSettingsDto dto.UpdateNetworkSettingsDTO
	err := e.parsePayload(job.Payload, &updateNetworkSettingsDto)
	if err != nil {
		return nil, common.FormatRecoverableError(fmt.Errorf("failed to unmarshal payload: %w", err))
	}

	return nil, e.backend.UpdateNetworkSettings(ctx, job.ResourceId, updateNetworkSettingsDto)
}

func (e *Executor) recoverBox(ctx context.Context, job *apiclient.Job) (any, error) {
	if err := rejectLegacyCapabilityFields(job.Payload, apiclient.JOBTYPE_RECOVER_BOX_WITH_CAPABILITIES_V2); err != nil {
		return nil, err
	}
	var recoverBoxDto dto.RecoverBoxDTO
	err := e.parsePayload(job.Payload, &recoverBoxDto)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	return e.executeRecoverBox(ctx, job.ResourceId, recoverBoxDto)
}

func (e *Executor) recoverBoxWithCapabilities(ctx context.Context, job *apiclient.Job) (any, error) {
	var request dto.RecoverBoxWithCapabilitiesDTO
	if err := parseStrictPayload(job.Payload, &request); err != nil {
		return nil, fmt.Errorf("failed to unmarshal payload: %w", err)
	}
	if !request.HasCapabilityPolicy() {
		return nil, fmt.Errorf("capability recovery job requires advanced.capabilities.add or advanced.capabilities.drop")
	}
	return e.executeRecoverBox(ctx, job.ResourceId, request.AsRecoverBoxDTO())
}

func (e *Executor) executeRecoverBox(ctx context.Context, boxID string, recoverBoxDto dto.RecoverBoxDTO) (any, error) {
	err := e.backend.RecoverBox(ctx, boxID, recoverBoxDto)
	if err != nil {
		return nil, common.FormatRecoverableError(err)
	}

	return nil, nil
}

// resizeBox remains as a compatibility sink for jobs created by older API
// deployments. It must fail before touching the box.
func (e *Executor) resizeBox(_ context.Context, _ *apiclient.Job) (any, error) {
	return nil, errdefs.ErrNotImplemented.WithMessage("box resource resize is not supported")
}
