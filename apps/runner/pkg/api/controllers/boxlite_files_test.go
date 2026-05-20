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
	// Two errors: the blank path, then the orphaned file part that now
	// has no destination to pair against. Reporting both lets clients
	// fix everything in one round-trip.
	if len(errs) != 2 {
		t.Fatalf("expected 2 errors (empty path + orphan file), got %v", errs)
	}
	if !strings.Contains(errs[0], "empty") {
		t.Errorf("first error should mention empty path, got %q", errs[0])
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
