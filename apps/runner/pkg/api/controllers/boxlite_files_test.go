package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gin-gonic/gin"
)

// renderCopyError drives the production renderer and hands back what a client
// would actually receive.
func renderCopyError(t *testing.T, err error) (int, map[string]any) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPut, "/v1/boxes/b/files?path=/tmp/x", nil)

	respondCopyError(ctx, err)

	var body map[string]any
	if unmarshalErr := json.Unmarshal(recorder.Body.Bytes(), &body); unmarshalErr != nil {
		t.Fatalf("response body is not JSON (%v): %s", unmarshalErr, recorder.Body.String())
	}
	return recorder.Code, body
}

// errorEnvelope pulls the (message, type, code) triple out of the wire shape
// openapi/box.openapi.yaml declares for these routes. Reports absence rather
// than failing, so a test can say which part is missing.
func errorEnvelope(body map[string]any) (message, errorType, code string, ok bool) {
	inner, isObject := body["error"].(map[string]any)
	if !isObject {
		return "", "", "", false
	}
	message, _ = inner["message"].(string)
	errorType, _ = inner["type"].(string)
	code, _ = inner["code"].(string)
	return message, errorType, code, true
}

// A path the guest refuses because a mount hides it is the caller's mistake,
// and openapi/box.openapi.yaml documents it as `400` on both file routes.
//
// The class survives every hop up to here — the guest answers
// FailedPrecondition, map_tonic_err turns that into BoxliteError::Unsupported,
// and the FFI hands Go an *Error carrying ErrUnsupported — and then the runner
// used to throw it away and call every copy failure a 500. That is a server
// fault reported for a request only the caller can fix, and it is the same
// flattening already fixed on the two client-side backends
// (src/boxlite/src/portal/interfaces/files.rs, src/boxlite/src/rest/litebox.rs)
// whose decoder has nothing to read without the envelope below.
func TestRefusedCopyKeepsItsClass(t *testing.T) {
	const refusal = "unsupported: /tmp/x is under the container's '/tmp' mount, " +
		"which file transfer cannot reach"

	status, body := renderCopyError(t, &boxlite.Error{
		Code:    boxlite.ErrUnsupported,
		Message: refusal,
	})

	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body: %v)", status, http.StatusBadRequest, body)
	}
	message, errorType, code, ok := errorEnvelope(body)
	if !ok {
		t.Fatalf("body is not the {error:{message,type,code}} envelope the client decodes: %v", body)
	}
	if code != "unsupported" {
		t.Errorf("code = %q, want %q", code, "unsupported")
	}
	if errorType != "UnsupportedError" {
		t.Errorf("type = %q, want %q", errorType, "UnsupportedError")
	}
	// The examples fail closed on this exact fragment, so the wording has to
	// reach the caller intact and not just the class.
	if !strings.Contains(message, "'/tmp' mount") {
		t.Errorf("message dropped the mount fragment the examples match: %q", message)
	}
}

// Every code the Go SDK can return, against the table BoxliteError::http()
// keeps in src/shared/src/errors.rs. Pinned whole rather than for the refusal
// alone: a copy also reports missing sources, oversized uploads and stopped
// boxes, and each was flattened the same way.
func TestCopyErrorsMapToTheirCanonicalHTTPClass(t *testing.T) {
	cases := []struct {
		code      boxlite.ErrorCode
		status    int
		errorType string
		wireCode  string
	}{
		{boxlite.ErrInternal, http.StatusInternalServerError, "InternalError", "internal"},
		{boxlite.ErrNotFound, http.StatusNotFound, "NotFoundError", "not_found"},
		{boxlite.ErrAlreadyExists, http.StatusConflict, "AlreadyExistsError", "already_exists"},
		{boxlite.ErrInvalidState, http.StatusConflict, "InvalidStateError", "invalid_state"},
		{boxlite.ErrInvalidArgument, http.StatusBadRequest, "InvalidArgumentError", "invalid_argument"},
		{boxlite.ErrConfig, http.StatusInternalServerError, "ConfigError", "config_error"},
		{boxlite.ErrStorage, http.StatusInternalServerError, "StorageError", "storage_error"},
		{boxlite.ErrImage, http.StatusUnprocessableEntity, "ImageError", "image_pull_failed"},
		{boxlite.ErrNetwork, http.StatusServiceUnavailable, "NetworkError", "network_unavailable"},
		{boxlite.ErrExecution, http.StatusUnprocessableEntity, "ExecutionError", "execution_failed"},
		{boxlite.ErrStopped, http.StatusConflict, "StoppedError", "stopped"},
		{boxlite.ErrEngine, http.StatusServiceUnavailable, "EngineError", "engine_unavailable"},
		{boxlite.ErrUnsupported, http.StatusBadRequest, "UnsupportedError", "unsupported"},
		{boxlite.ErrDatabase, http.StatusInternalServerError, "DatabaseError", "database_error"},
		{boxlite.ErrPortal, http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
		{boxlite.ErrRpc, http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
		{boxlite.ErrRpcTransport, http.StatusServiceUnavailable, "UpstreamUnavailableError", "upstream_unavailable"},
		{boxlite.ErrMetadata, http.StatusInternalServerError, "MetadataError", "metadata_error"},
		{boxlite.ErrUnsupportedEngine, http.StatusBadRequest, "UnsupportedError", "unsupported"},
		{boxlite.ErrResourceExhausted, http.StatusTooManyRequests, "ResourceExhaustedError", "resource_exhausted"},
		{boxlite.ErrSessionReaped, http.StatusGone, "SessionReapedError", "session_reaped"},
	}

	for _, want := range cases {
		status, body := renderCopyError(t, &boxlite.Error{Code: want.code, Message: "boom"})
		_, errorType, wireCode, ok := errorEnvelope(body)
		if !ok {
			t.Errorf("code %d: body is not the error envelope: %v", want.code, body)
			continue
		}
		if status != want.status || errorType != want.errorType || wireCode != want.wireCode {
			t.Errorf("code %d: got (%d, %q, %q), want (%d, %q, %q)",
				want.code, status, errorType, wireCode,
				want.status, want.errorType, want.wireCode)
		}
	}
}

// A failure that never crossed the FFI — a staging or transport fault on the
// runner itself — has no class to preserve, so it stays a server fault. Pinned
// so the mapping cannot start guessing 400 for errors the runtime never
// classified.
func TestUnclassifiedCopyFailureStaysInternal(t *testing.T) {
	status, body := renderCopyError(t, errPlain("staging dir vanished"))

	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", status, http.StatusInternalServerError)
	}
	message, _, code, ok := errorEnvelope(body)
	if !ok {
		t.Fatalf("body is not the error envelope: %v", body)
	}
	if code != "internal" {
		t.Errorf("code = %q, want %q", code, "internal")
	}
	if !strings.Contains(message, "staging dir vanished") {
		t.Errorf("message dropped the cause: %q", message)
	}
}

// A code from an FFI newer than this table is the one case where answering
// 500 is right — a server cannot invent a status for a class it has no name
// for. What it must not do is answer with the zero value the map lookup
// returns, which is HTTP status 0 and an empty type. The runtime's own
// wording still has to reach the caller.
func TestACodeThisTableDoesNotKnowStaysInternal(t *testing.T) {
	const unknown = boxlite.ErrorCode(9999)

	status, body := renderCopyError(t, &boxlite.Error{
		Code:    unknown,
		Message: "a class this build has no name for",
	})

	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d (body: %v)", status, http.StatusInternalServerError, body)
	}
	message, errorType, code, ok := errorEnvelope(body)
	if !ok {
		t.Fatalf("body is not the error envelope: %v", body)
	}
	if code != "internal" || errorType != "InternalError" {
		t.Errorf("got (%q, %q), want (%q, %q)", errorType, code, "InternalError", "internal")
	}
	if !strings.Contains(message, "a class this build has no name for") {
		t.Errorf("message dropped the runtime's wording: %q", message)
	}
}

// The routes answer in one shape or the client can only read some of them.
//
// Both handlers also report failures of their own — an uninitialised runtime, a
// missing `path`, a staging directory that could not be made, a tar that would
// not extract. Each used to answer `{"error": "<text>"}`, which names no class,
// so the client fell back to reading the status alone and reported them exactly
// the way it reported a refusal: as a server fault. Driven through the real
// handlers, which reach their first failure with no runner instance configured.
func TestFilesRoutesAnswerInTheDeclaredEnvelope(t *testing.T) {
	routes := map[string]struct {
		handle func(*gin.Context)
		method string
	}{
		"upload":   {BoxliteFileUpload, http.MethodPut},
		"download": {BoxliteFileDownload, http.MethodGet},
	}

	for name, route := range routes {
		gin.SetMode(gin.TestMode)
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Request = httptest.NewRequest(route.method, "/v1/boxes/b/files?path=/tmp/x", nil)

		route.handle(ctx)

		var body map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Errorf("%s: response body is not JSON (%v): %s", name, err, recorder.Body.String())
			continue
		}
		message, errorType, code, ok := errorEnvelope(body)
		if !ok {
			t.Errorf("%s: body is not the {error:{message,type,code}} envelope: %v", name, body)
			continue
		}
		if message == "" || errorType == "" || code == "" {
			t.Errorf("%s: envelope is missing a field: message=%q type=%q code=%q",
				name, message, errorType, code)
		}
	}
}

type errPlain string

func (e errPlain) Error() string { return string(e) }
