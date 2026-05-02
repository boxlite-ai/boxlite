// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

package errors

import (
	"encoding/json"
	"errors"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func ConvertOpenAPIError(err error) error {
	if err == nil {
		return nil
	}

	openapiErr := &apiclient.GenericOpenAPIError{}
	if !errors.As(err, &openapiErr) {
		return err
	}

	bodyString := string(openapiErr.Body())

	boxliteErr := &ErrorResponse{}
	if parseErr := json.Unmarshal([]byte(bodyString), boxliteErr); parseErr != nil {
		return err
	}

	return NewCustomError(boxliteErr.StatusCode, boxliteErr.Message, boxliteErr.Code)
}

func IsRetryableOpenAPIError(err error) bool {
	if err == nil {
		return false
	}

	if customErr, ok := err.(*CustomError); ok {
		return customErr.IsRetryable()
	}

	return true
}
