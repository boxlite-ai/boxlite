package controllers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

// fakeBoxFS captures CopyInto / CopyOut calls and lets tests stash file
// content or stage canned bytes for the download path. The hooks (onCopyIn /
// onCopyOut) run with the mutex held.
type fakeBoxFS struct {
	mu         sync.Mutex
	intoCalls  []fakeCopyCall
	outCalls   []fakeCopyCall
	onCopyIn   func(boxId, src, dest string) error
	onCopyOut  func(boxId, src, dest string) error
}

type fakeCopyCall struct {
	boxId, src, dest string
	srcContents      []byte
}

func (f *fakeBoxFS) CopyInto(_ context.Context, boxId, hostSrc, guestDst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Snapshot the host tmp file's contents before the handler removes it,
	// so tests can assert that the request body actually landed on disk.
	body, _ := os.ReadFile(hostSrc)
	f.intoCalls = append(f.intoCalls, fakeCopyCall{boxId: boxId, src: hostSrc, dest: guestDst, srcContents: body})
	if f.onCopyIn != nil {
		return f.onCopyIn(boxId, hostSrc, guestDst)
	}
	return nil
}

func (f *fakeBoxFS) CopyOut(_ context.Context, boxId, guestSrc, hostDst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outCalls = append(f.outCalls, fakeCopyCall{boxId: boxId, src: guestSrc, dest: hostDst})
	if f.onCopyOut != nil {
		return f.onCopyOut(boxId, guestSrc, hostDst)
	}
	return nil
}

// installFakeBoxFS swaps in the fake for the duration of the test.
func installFakeBoxFS(t *testing.T, fake *fakeBoxFS) {
	t.Helper()
	prev := boxFSOverride
	boxFSOverride = fake
	t.Cleanup(func() { boxFSOverride = prev })
}

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

// runBulkDownloadHandlerCtx is the request-context-aware variant of
// runBulkDownloadHandler used by the cancellation test. The default
// runBulkDownloadHandler builds a request with context.Background(),
// which cannot be canceled from the test body.
func runBulkDownloadHandlerCtx(reqCtx context.Context, target, contentType, body string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/v1/boxes/:boxId/files/bulk-download", BoxliteFilesBulkDownload)
	req := httptest.NewRequest(http.MethodPost, target, bytes.NewBufferString(body)).WithContext(reqCtx)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// TestBoxliteFilesBulkDownload_HappyPath pins that each requested path
// becomes one `name="file"; filename="<path>"` part in the multipart
// response, that the bytes CopyOut writes to the host tmp dest end up in
// the corresponding part body verbatim, and that the response advertises
// the documented BOXLITE-FILE-BOUNDARY boundary.
func TestBoxliteFilesBulkDownload_HappyPath(t *testing.T) {
	contents := map[string]string{
		"/etc/a.txt": "alpha-bytes",
		"/etc/b.txt": "bravo-bytes",
	}
	fake := &fakeBoxFS{
		onCopyOut: func(_ /*boxId*/, guestSrc, hostDst string) error {
			body, ok := contents[guestSrc]
			if !ok {
				return fmt.Errorf("unexpected path %q", guestSrc)
			}
			return os.WriteFile(hostDst, []byte(body), 0o644)
		},
	}
	installFakeBoxFS(t, fake)

	w := runBulkDownloadHandler(
		"/v1/boxes/box-42/files/bulk-download",
		"application/json",
		`{"paths":["/etc/a.txt","/etc/b.txt"]}`,
	)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "multipart/form-data") || !strings.Contains(ct, "BOXLITE-FILE-BOUNDARY") {
		t.Fatalf("Content-Type missing multipart/BOXLITE-FILE-BOUNDARY: %q", ct)
	}

	mr := multipart.NewReader(w.Body, "BOXLITE-FILE-BOUNDARY")
	got := make(map[string]string, 2)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart: %v", err)
		}
		// part.FileName() runs filepath.Base on the filename param (Go
		// stdlib applies RFC 7578 §4.2 anti-traversal stripping), so a
		// header of filename="/etc/a.txt" would come back as "a.txt".
		// The wire contract here is "filename carries the full box-side
		// path verbatim" (matches daemon and Rust serve handlers), so we
		// parse Content-Disposition directly to preserve the path.
		_, params, dispErr := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if dispErr != nil {
			t.Fatalf("parse Content-Disposition: %v", dispErr)
		}
		filename := params["filename"]
		buf, _ := io.ReadAll(part)
		part.Close()
		// The handler emits Content-Disposition name="file" on success
		// and name="error" on failure — distinguish via FormName().
		if part.FormName() != "file" {
			t.Errorf("expected name=file part, got name=%q for filename=%q", part.FormName(), filename)
			continue
		}
		got[filename] = string(buf)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 file parts, got %d (%v)", len(got), got)
	}
	for path, want := range contents {
		if got[path] != want {
			t.Errorf("part %s: want %q, got %q", path, want, got[path])
		}
	}
}

// TestBoxliteFilesBulkDownload_StopsCopyOutAfterContextCanceled pins the
// early-bail behaviour: when the request context is canceled mid-batch,
// subsequent iterations of the streaming loop must not invoke CopyOut.
// The ctxWriter wrapper already aborts an in-flight io.Copy, but without
// the per-iteration ctx.Err() check the handler would still spend one
// CopyOut FFI roundtrip per remaining path before the next write
// noticed the disconnect.
func TestBoxliteFilesBulkDownload_StopsCopyOutAfterContextCanceled(t *testing.T) {
	reqCtx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	fake := &fakeBoxFS{
		onCopyOut: func(_ /*boxId*/, _ /*src*/, hostDst string) error {
			// Cancel the request mid-batch — simulates client disconnect
			// after the first file has been extracted. Subsequent loop
			// iterations must see ctx.Err() != nil and bail out before
			// calling CopyOut again.
			cancel()
			return os.WriteFile(hostDst, []byte("x"), 0o644)
		},
	}
	installFakeBoxFS(t, fake)

	w := runBulkDownloadHandlerCtx(
		reqCtx,
		"/v1/boxes/box-42/files/bulk-download",
		"application/json",
		`{"paths":["/etc/a.txt","/etc/b.txt","/etc/c.txt"]}`,
	)

	// Status header was committed before the cancel observation, so the
	// recorder still shows 200 — the assertion that matters is the
	// CopyOut call count.
	_ = w
	if len(fake.outCalls) != 1 {
		t.Fatalf("expected exactly 1 CopyOut before bail, got %d (%v)", len(fake.outCalls), fake.outCalls)
	}
}

// runFileUploadHandler routes a single-file PUT through gin like the
// production engine does, so the handler reads ctx.Request.Body and
// query params exactly as it would in serve.
func runFileUploadHandler(target string, body io.Reader) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Handle(http.MethodPut, "/v1/boxes/:boxId/files", BoxliteFileUpload)
	req := httptest.NewRequest(http.MethodPut, target, body)
	req.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// runFileDownloadHandler is the GET counterpart.
func runFileDownloadHandler(target string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Handle(http.MethodGet, "/v1/boxes/:boxId/files", BoxliteFileDownload)
	req := httptest.NewRequest(http.MethodGet, target, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// TestBoxliteFileUpload_RawBytesReachCopyInto pins that a PUT body is
// written to a host tmp file and that file's path is handed to
// CopyInto unchanged, with the raw request bytes intact.
func TestBoxliteFileUpload_RawBytesReachCopyInto(t *testing.T) {
	fake := &fakeBoxFS{}
	installFakeBoxFS(t, fake)

	const want = "hello-from-test"
	w := runFileUploadHandler("/v1/boxes/box-42/files?path=/etc/dest.txt", strings.NewReader(want))
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", w.Code, w.Body.String())
	}
	if len(fake.intoCalls) != 1 {
		t.Fatalf("expected exactly 1 CopyInto call, got %d", len(fake.intoCalls))
	}
	call := fake.intoCalls[0]
	if call.boxId != "box-42" {
		t.Errorf("boxId: want box-42, got %q", call.boxId)
	}
	if call.dest != "/etc/dest.txt" {
		t.Errorf("dest: want /etc/dest.txt, got %q", call.dest)
	}
	if string(call.srcContents) != want {
		t.Errorf("tmp file contents: want %q, got %q", want, string(call.srcContents))
	}
}

// TestBoxliteFileDownload_StreamsRawBytes pins that bytes written to the
// host tmp dest by CopyOut are streamed back in the response body
// verbatim with the expected octet-stream content type.
func TestBoxliteFileDownload_StreamsRawBytes(t *testing.T) {
	const guestBody = "downloaded-bytes"
	fake := &fakeBoxFS{
		onCopyOut: func(_ /*boxId*/, _ /*src*/, hostDst string) error {
			return os.WriteFile(hostDst, []byte(guestBody), 0o644)
		},
	}
	installFakeBoxFS(t, fake)

	w := runFileDownloadHandler("/v1/boxes/box-42/files?path=/etc/foo.txt")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != guestBody {
		t.Errorf("response body: want %q, got %q", guestBody, got)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type: want application/octet-stream, got %q", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "foo.txt") {
		t.Errorf("Content-Disposition should reference foo.txt, got %q", cd)
	}
}

// TestBoxliteFilesBulkUpload_HappyPath pins that two valid pairs are
// staged, CopyInto runs once per pair, and the response surfaces both
// destinations under "uploaded" with no "errors" key.
func TestBoxliteFilesBulkUpload_HappyPath(t *testing.T) {
	fake := &fakeBoxFS{}
	installFakeBoxFS(t, fake)

	body, ct := writeBulkUploadBody(t, []struct{ name, value string }{
		{"files[0].path", "/etc/a.txt"},
		{"files[0].file", "alpha"},
		{"files[1].path", "/etc/b.txt"},
		{"files[1].file", "bravo"},
	})
	w := runBulkUploadHandler(http.MethodPost, "/v1/boxes/box-42/files/bulk-upload", ct, body)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if len(fake.intoCalls) != 2 {
		t.Fatalf("expected exactly 2 CopyInto calls, got %d", len(fake.intoCalls))
	}
	destsByContent := make(map[string]string, 2)
	for _, c := range fake.intoCalls {
		destsByContent[string(c.srcContents)] = c.dest
	}
	if destsByContent["alpha"] != "/etc/a.txt" {
		t.Errorf("alpha staged at wrong dest: %q", destsByContent["alpha"])
	}
	if destsByContent["bravo"] != "/etc/b.txt" {
		t.Errorf("bravo staged at wrong dest: %q", destsByContent["bravo"])
	}

	var resp struct {
		Uploaded []string `json:"uploaded"`
		Errors   []string `json:"errors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v body=%s", err, w.Body.String())
	}
	if len(resp.Errors) != 0 {
		t.Errorf("expected no errors on happy path, got %v", resp.Errors)
	}
	if len(resp.Uploaded) != 2 {
		t.Fatalf("expected 2 uploaded entries, got %v", resp.Uploaded)
	}
}
