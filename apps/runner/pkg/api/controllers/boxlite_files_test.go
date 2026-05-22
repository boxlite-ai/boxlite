package controllers

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestExtractBulkUploadIndex(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"files[0].path", "0"},
		{"files[0].file", "0"},
		{"files[42].path", "42"},
		{"files[abc].file", "abc"},
		// Non-conforming names come back as-is; the caller filters them
		// out by checking the .path/.file suffix before using the index.
		{"unrelated", "unrelated"},
		{"files[only-prefix", "only-prefix"},
	}
	for _, c := range cases {
		if got := extractBulkUploadIndex(c.in); got != c.want {
			t.Errorf("extractBulkUploadIndex(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// writeBulkUploadBody assembles a multipart body alternating .path and
// .file parts so test cases can describe what they want as data, not as
// raw multipart framing.
func writeBulkUploadBody(t *testing.T, parts []struct{ name, value string }) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	for _, p := range parts {
		fw, err := mw.CreateFormField(p.name)
		if err != nil {
			t.Fatalf("CreateFormField(%q): %v", p.name, err)
		}
		if _, err := fw.Write([]byte(p.value)); err != nil {
			t.Fatalf("write %q: %v", p.name, err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}
	return body, mw.FormDataContentType()
}

// readerFromMultipart turns a multipart-encoded body into a
// *multipart.Reader the way parseBulkUploadParts will see it in
// production, so the test exercises the same parsing path the handler
// uses (not a hand-rolled fixture).
func readerFromMultipart(t *testing.T, body *bytes.Buffer, contentType string) *multipart.Reader {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set("Content-Type", contentType)
	mr, err := req.MultipartReader()
	if err != nil {
		t.Fatalf("MultipartReader: %v", err)
	}
	return mr
}

func TestParseBulkUploadParts_StagesValidPairs(t *testing.T) {
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].path", "/tmp/a.txt"},
		{"files[0].file", "hello"},
		{"files[1].path", "/tmp/b.txt"},
		{"files[1].file", "world"},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(errs) != 0 {
		t.Fatalf("expected no errors, got %v", errs)
	}
	if len(staged) != 2 {
		t.Fatalf("expected 2 staged, got %d", len(staged))
	}

	wantContents := map[string]string{
		"/tmp/a.txt": "hello",
		"/tmp/b.txt": "world",
	}
	for _, s := range staged {
		want, ok := wantContents[s.Dest]
		if !ok {
			t.Fatalf("unexpected dest %q", s.Dest)
		}
		got, err := os.ReadFile(s.Src)
		if err != nil {
			t.Fatalf("read staged %q: %v", s.Src, err)
		}
		if string(got) != want {
			t.Errorf("staged %s: got %q, want %q", s.Dest, got, want)
		}
	}
}

func TestParseBulkUploadParts_FileBeforePathErrors(t *testing.T) {
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		// .file arrives before its .path — the daemon contract is that
		// .path must precede .file at the same index. We surface that as
		// a per-file error rather than silently dropping the file or
		// 500-ing the whole batch.
		{"files[0].file", "orphan"},
		{"files[0].path", "/tmp/late.txt"},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(staged) != 0 {
		t.Errorf("expected nothing staged when path arrives after file, got %v", staged)
	}
	if len(errs) != 1 || !strings.Contains(errs[0], "missing .path metadata") {
		t.Errorf("expected 1 'missing .path metadata' error, got %v", errs)
	}
}

func TestParseBulkUploadParts_EmptyPathErrors(t *testing.T) {
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].path", "   "},
		{"files[0].file", "anything"},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(staged) != 0 {
		t.Errorf("expected nothing staged for empty path, got %v", staged)
	}
	// Only the blank-path error: the orphaned .file part is suppressed
	// because we already rejected this index's .path with a more specific
	// reason. Reporting "missing .path metadata" alongside "path[N]: empty"
	// would be misleading — the path did precede the file, it was blank.
	if len(errs) != 1 {
		t.Fatalf("expected 1 error (empty path; orphan-file suppressed), got %v", errs)
	}
	if !strings.Contains(errs[0], "empty") {
		t.Errorf("error should mention empty path, got %q", errs[0])
	}
}

// TestParseBulkUploadParts_FileBeforePathStillErrors guards against the
// rejected-index suppression in EmptyPathErrors swallowing the genuine
// "missing .path metadata" case where no .path was sent for that index.
func TestParseBulkUploadParts_FileBeforePathStillErrors(t *testing.T) {
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].file", "orphan-with-no-path-ever"},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(staged) != 0 {
		t.Errorf("expected nothing staged, got %v", staged)
	}
	if len(errs) != 1 || !strings.Contains(errs[0], "missing .path metadata") {
		t.Errorf("expected 1 'missing .path metadata' error, got %v", errs)
	}
}

// TestParseBulkUploadParts_PathExceedsCap asserts that a multi-KiB .path
// part is rejected with the cap error rather than read into memory in
// full — an unbounded io.ReadAll on the .path part is a DoS surface
// (one large request could exhaust the runner's RAM).
func TestParseBulkUploadParts_PathExceedsCap(t *testing.T) {
	huge := strings.Repeat("x", bulkUploadMaxPathBytes+1)
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].path", huge},
		{"files[0].file", "ignored"},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(staged) != 0 {
		t.Errorf("expected nothing staged when .path exceeds cap, got %v", staged)
	}
	if len(errs) != 1 || !strings.Contains(errs[0], "exceeds") {
		t.Fatalf("expected 1 'exceeds' error for oversized .path, got %v", errs)
	}
}

// TestParseBulkUploadParts_FileExceedsCap covers the per-file size cap
// in stageBulkUploadPart — an unbounded io.Copy on a .file part is a
// disk-exhaustion surface, multiplied by the number of files per
// request.
func TestParseBulkUploadParts_FileExceedsCap(t *testing.T) {
	huge := strings.Repeat("y", bulkUploadMaxFileBytes+1)
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].path", "/tmp/large.bin"},
		{"files[0].file", huge},
	})

	staged, errs := parseBulkUploadParts(readerFromMultipart(t, body, ct))
	t.Cleanup(func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	})

	if len(staged) != 0 {
		t.Errorf("expected nothing staged when .file exceeds cap, got %v", staged)
	}
	if len(errs) != 1 || !strings.Contains(errs[0], "exceeds") {
		t.Fatalf("expected 1 'exceeds' error for oversized .file, got %v", errs)
	}
}

// runBulkUploadHandler routes the request through a real gin engine so
// the multipart parser sees the request the same way it does in
// production. Mirrors the pattern in boxlite_exec_test.go.
func runBulkUploadHandler(method, target, contentType string, body *bytes.Buffer) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Handle(method, "/v1/boxes/:boxId/files/bulk-upload", BoxliteFilesBulkUpload)
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestBoxliteFilesBulkUpload_InvalidMultipartReturns400(t *testing.T) {
	// A POST without multipart framing should never reach the runner —
	// the handler must short-circuit on MultipartReader() failure with a
	// 400 so tests don't need a live runner singleton to assert it.
	w := runBulkUploadHandler(
		http.MethodPost,
		"/v1/boxes/box/files/bulk-upload",
		"application/json",
		bytes.NewBufferString(`{"not":"multipart"}`),
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestBoxliteFilesBulkUpload_AllErrorsSkipsRunner(t *testing.T) {
	// When every part fails parsing (here: file-before-path), the
	// handler reports the errors with 400 and must not reach
	// runner.GetInstance — otherwise an uninitialized test process
	// would 500 on a request that has nothing to copy.
	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].file", "orphan"},
	})

	w := runBulkUploadHandler(
		http.MethodPost,
		"/v1/boxes/box/files/bulk-upload",
		ct,
		body,
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing .path metadata") {
		t.Errorf("expected per-part error in body, got %s", w.Body.String())
	}
}

// runBulkDownloadHandler routes the request through a real gin engine so
// the JSON binding sees the request the same way it does in production.
// Mirrors runBulkUploadHandler above.
func runBulkDownloadHandler(target, contentType, body string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/v1/boxes/:boxId/files/bulk-download", BoxliteFilesBulkDownload)
	req := httptest.NewRequest(http.MethodPost, target, bytes.NewBufferString(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func TestBoxliteFilesBulkDownload_InvalidJSONReturns400(t *testing.T) {
	// Malformed JSON must short-circuit before reaching runner.GetInstance.
	// gin's BindJSON writes the 400 itself; the handler must not also
	// commit the multipart Content-Type, otherwise the client gets a
	// 400 with a body that looks like a multipart preamble.
	w := runBulkDownloadHandler(
		"/v1/boxes/box/files/bulk-download",
		"application/json",
		`{not json`,
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); strings.HasPrefix(ct, "multipart/") {
		t.Errorf("multipart Content-Type leaked on 400: %q", ct)
	}
}

func TestBoxliteFilesBulkDownload_EmptyPathsReturns400(t *testing.T) {
	// {"paths": []} is well-formed JSON but useless; we reject it
	// explicitly so the client sees the documented error message rather
	// than an empty 200 multipart body.
	w := runBulkDownloadHandler(
		"/v1/boxes/box/files/bulk-download",
		"application/json",
		`{"paths": []}`,
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "non-empty") {
		t.Errorf("expected 'non-empty' in error body, got %s", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); strings.HasPrefix(ct, "multipart/") {
		t.Errorf("multipart Content-Type leaked on 400: %q", ct)
	}
}

func TestBoxliteFilesBulkDownload_MissingPathsFieldReturns400(t *testing.T) {
	// A body without the paths field unmarshals to the zero value (nil
	// slice). The handler treats that identically to an empty slice.
	w := runBulkDownloadHandler(
		"/v1/boxes/box/files/bulk-download",
		"application/json",
		`{}`,
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "non-empty") {
		t.Errorf("expected 'non-empty' in error body, got %s", w.Body.String())
	}
}
