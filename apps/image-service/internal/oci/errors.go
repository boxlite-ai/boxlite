// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package oci

// ErrorCode is a distribution-spec error code. A registry client reads the code
// to tell a refusal it can act on from one it cannot, so answering with the
// wrong one turns a fixable problem into a mysterious failure.
//
// https://github.com/opencontainers/distribution-spec/blob/main/spec.md#error-codes
type ErrorCode string

const (
	CodeNameInvalid     ErrorCode = "NAME_INVALID"
	CodeManifestInvalid ErrorCode = "MANIFEST_INVALID"
	CodeUnauthorized    ErrorCode = "UNAUTHORIZED"
	CodeDenied          ErrorCode = "DENIED"
	CodeUnsupported     ErrorCode = "UNSUPPORTED"
	CodeTooManyRequests ErrorCode = "TOOMANYREQUESTS"
)

// ErrorBody is the document a registry answers a refusal with.
type ErrorBody struct {
	Errors []ErrorDetail `json:"errors"`
}

// ErrorDetail is one reason inside an ErrorBody.
type ErrorDetail struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

// Refusal builds the body for a single-reason refusal.
func Refusal(code ErrorCode, message string) ErrorBody {
	return ErrorBody{Errors: []ErrorDetail{{Code: code, Message: message}}}
}
