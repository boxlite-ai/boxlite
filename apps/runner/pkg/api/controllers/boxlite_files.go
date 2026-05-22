package controllers

import (
	"context"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"

	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// Bulk-upload size caps. Tune by operator capacity.
const (
	bulkUploadMaxPathBytes = 4096           // 4 KiB per files[N].path part
	bulkUploadMaxFileBytes = 256 << 20      // 256 MiB per files[N].file part
)

// boxFS is the narrow slice of the runner Boxlite client that the file
// handlers use. Defined here so tests can drive the happy path through
// a fake without booting the real SDK singleton.
type boxFS interface {
	CopyInto(ctx context.Context, boxId, hostSrc, guestDst string) error
	CopyOut(ctx context.Context, boxId, guestSrc, hostDst string) error
}

// boxFSOverride lets tests substitute the boxFS implementation; prod
// leaves it nil and resolves via runner.GetInstance() at call time.
var boxFSOverride boxFS

func resolveBoxFS() (boxFS, error) {
	if boxFSOverride != nil {
		return boxFSOverride, nil
	}
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, err
	}
	return r.Boxlite, nil
}

// BoxliteFileUpload streams a single file's raw bytes from the request
// body into a path inside the box. The body is buffered to a host tmp
// file first because the underlying SDK CopyInto takes a host path, not
// an io.Reader.
//
//	@Summary		Upload a file to a box
//	@Description	Writes the raw request body to the given path inside the box.
//	@Tags			boxlite
//	@Accept			application/octet-stream
//	@Produce		json
//	@Param			boxId	path	string	true	"Box ID"
//	@Param			path	query	string	true	"Destination path inside the box"
//	@Param			body	body	string	true	"File contents (raw bytes)"
//	@Success		204
//	@Failure		400	{object}	map[string]string	"bad request"
//	@Failure		500	{object}	map[string]string	"internal error"
//	@Router			/v1/boxes/{boxId}/files [put]
func BoxliteFileUpload(ctx *gin.Context) {
	fs, err := resolveBoxFS()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	boxId := ctx.Param("boxId")
	destPath := ctx.Query("path")
	if destPath == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "path query parameter required"})
		return
	}

	tmpFile, err := os.CreateTemp("", "boxlite-upload-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp file"})
		return
	}
	defer os.Remove(tmpFile.Name())
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, ctx.Request.Body); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "failed to read upload body"})
		return
	}
	tmpFile.Close()

	if err := fs.CopyInto(ctx.Request.Context(), boxId, tmpFile.Name(), destPath); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}

	ctx.Status(http.StatusNoContent)
}

// BoxliteFileDownload reads a single file out of the box and streams its
// raw bytes back to the caller. The SDK's CopyOut auto-detects file-to-file
// vs into-directory mode based on whether the host destination already
// exists as a directory; we hand it a fresh tmp file path so the file lands
// directly at that path with no tar staging on the runner side.
//
//	@Summary		Download a file from a box
//	@Description	Streams the contents of a single file inside the box back as raw bytes.
//	@Tags			boxlite
//	@Produce		application/octet-stream
//	@Param			boxId	path		string				true	"Box ID"
//	@Param			path	query		string				true	"Source path inside the box"
//	@Success		200		{string}	binary				"file contents"
//	@Failure		400		{object}	map[string]string	"bad request"
//	@Failure		500		{object}	map[string]string	"internal error"
//	@Router			/v1/boxes/{boxId}/files [get]
func BoxliteFileDownload(ctx *gin.Context) {
	fs, err := resolveBoxFS()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	boxId := ctx.Param("boxId")
	srcPath := ctx.Query("path")
	if srcPath == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "path query parameter required"})
		return
	}

	// CopyOut needs a concrete host path; create a 0-byte tmp file and let
	// CopyOut overwrite it (default opts include overwrite=true, see
	// sdks/c/src/copy.rs default_copy_options). defer removes it on exit.
	tmpFile, err := os.CreateTemp("", "boxlite-download-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp file"})
		return
	}
	tmpPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := fs.CopyOut(ctx.Request.Context(), boxId, srcPath, tmpPath); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}

	f, err := os.Open(tmpPath)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open downloaded file"})
		return
	}
	defer f.Close()

	ctx.Header("Content-Type", "application/octet-stream")
	ctx.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(srcPath)))
	ctx.Status(http.StatusOK)
	_, _ = io.Copy(ctx.Writer, f)
}

// stagedBulkUpload pairs a destination path inside the box with a
// host-side tmp file holding that file's bytes. Callers own the tmp file
// and must remove it after CopyInto (or on early return).
type stagedBulkUpload struct {
	Dest string
	Src  string
}

// BoxliteFilesBulkUpload accepts a multipart body of the form
//
//	files[0].path = <dest inside box>
//	files[0].file = <bytes>
//	files[1].path = ...
//	files[1].file = ...
//
// and copies each file into the box via CopyInto. The endpoint is
// intentionally tolerant: parsing and copy errors are collected per-file
// rather than short-circuiting, so a single bad pair does not abort an
// otherwise-valid batch.
//
// Wire shape DIVERGES from the daemon-side handler at
// apps/daemon/pkg/toolbox/fs/upload_files.go: the daemon returns 200
// with an empty body on success and 400 with {"errors":[...]} on
// failure; this endpoint returns {"uploaded":[...]} on success and
// {"uploaded":[...], "errors":[...]} on partial failure so callers can
// tell which files made it without re-querying. The multipart parsing
// behaviour still mirrors the daemon (files[N].path must precede
// files[N].file, per-file errors don't abort the batch).
//
//	@Summary		Bulk-upload many files to a box in one multipart request
//	@Description	Accepts a multipart/form-data body where each file is described
//	@Description	by a pair of form fields: files[N].path (string destination
//	@Description	inside the box) followed by files[N].file (binary contents).
//	@Description	The .path part must precede its matching .file part. Per-file
//	@Description	errors are collected rather than aborting the batch: a 400 is
//	@Description	returned with both the uploaded list and the errors list when
//	@Description	any file fails; a 200 with only the uploaded list is returned
//	@Description	on full success.
//	@Tags			boxlite
//	@Accept			multipart/form-data
//	@Produce		json
//	@Param			boxId			path		string				true	"Box ID"
//	@Param			files[N].path	formData	string				true	"Destination path inside the box for file index N"
//	@Param			files[N].file	formData	file				true	"File contents for file index N"
//	@Success		200				{object}	map[string][]string	"{ uploaded: [destPath, ...] }"
//	@Failure		400				{object}	map[string][]string	"{ uploaded: [destPath, ...], errors: [perFileError, ...] }"
//	@Failure		500				{object}	map[string]string	"runner singleton failure"
//	@Router			/v1/boxes/{boxId}/files/bulk-upload [post]
func BoxliteFilesBulkUpload(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	if boxId == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "boxId is required"})
		return
	}

	reader, err := ctx.Request.MultipartReader()
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart form"})
		return
	}

	staged, errs := parseBulkUploadParts(reader)
	defer func() {
		for _, s := range staged {
			_ = os.Remove(s.Src)
		}
	}()

	uploaded := make([]string, 0, len(staged))
	if len(staged) > 0 {
		fs, err := resolveBoxFS()
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, s := range staged {
			if err := fs.CopyInto(ctx.Request.Context(), boxId, s.Src, s.Dest); err != nil {
				errs = append(errs, fmt.Sprintf("%s: copy: %v", s.Dest, err))
				continue
			}
			uploaded = append(uploaded, s.Dest)
		}
	}

	if len(errs) > 0 {
		ctx.JSON(http.StatusBadRequest, gin.H{"uploaded": uploaded, "errors": errs})
		return
	}
	ctx.JSON(http.StatusOK, gin.H{"uploaded": uploaded})
}

// parseBulkUploadParts streams the multipart body, stages each file part
// to a tmp file paired with its destination, and returns the staged
// uploads alongside any per-part errors. The caller owns the staged tmp
// files. Index pairing requires the .path part to appear before its
// matching .file part — matching the daemon-side handler's contract.
func parseBulkUploadParts(reader *multipart.Reader) ([]stagedBulkUpload, []string) {
	dests := make(map[string]string)
	rejected := make(map[string]bool)
	var staged []stagedBulkUpload
	var errs []string

	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			errs = append(errs, fmt.Sprintf("reading part: %v", err))
			continue
		}

		name := part.FormName()
		idx := extractBulkUploadIndex(name)

		switch {
		case strings.HasSuffix(name, ".path"):
			data, readErr := io.ReadAll(io.LimitReader(part, bulkUploadMaxPathBytes+1))
			part.Close()
			if readErr != nil {
				errs = append(errs, fmt.Sprintf("path[%s]: %v", idx, readErr))
				rejected[idx] = true
				continue
			}
			if len(data) > bulkUploadMaxPathBytes {
				errs = append(errs, fmt.Sprintf("path[%s]: exceeds %d bytes", idx, bulkUploadMaxPathBytes))
				rejected[idx] = true
				continue
			}
			dest := string(data)
			if strings.TrimSpace(dest) == "" {
				errs = append(errs, fmt.Sprintf("path[%s]: empty", idx))
				rejected[idx] = true
				continue
			}
			dests[idx] = dest

		case strings.HasSuffix(name, ".file"):
			dest, ok := dests[idx]
			if !ok {
				part.Close()
				if rejected[idx] {
					continue
				}
				errs = append(errs, fmt.Sprintf("file[%s]: missing .path metadata (must precede .file)", idx))
				continue
			}
			tmp, stageErr := stageBulkUploadPart(part)
			part.Close()
			if stageErr != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", dest, stageErr))
				continue
			}
			staged = append(staged, stagedBulkUpload{Dest: dest, Src: tmp})

		default:
			part.Close()
		}
	}
	return staged, errs
}

// stageBulkUploadPart writes a single part's bytes to a tmp file and
// returns its path. Returned path is non-empty only when err is nil.
func stageBulkUploadPart(part *multipart.Part) (string, error) {
	f, err := os.CreateTemp("", "boxlite-bulk-upload-*")
	if err != nil {
		return "", fmt.Errorf("tmp: %w", err)
	}
	name := f.Name()
	n, err := io.Copy(f, io.LimitReader(part, bulkUploadMaxFileBytes+1))
	if err != nil {
		f.Close()
		_ = os.Remove(name)
		return "", fmt.Errorf("write: %w", err)
	}
	if n > bulkUploadMaxFileBytes {
		f.Close()
		_ = os.Remove(name)
		return "", fmt.Errorf("exceeds %d bytes", bulkUploadMaxFileBytes)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("close: %w", err)
	}
	return name, nil
}

// extractBulkUploadIndex strips the files[N].path / files[N].file framing
// to return just N. Field names that don't follow the convention come
// back unchanged — callers filter those via the .path/.file suffix check.
func extractBulkUploadIndex(fieldName string) string {
	s := strings.TrimPrefix(fieldName, "files[")
	s = strings.TrimSuffix(s, "].path")
	s = strings.TrimSuffix(s, "].file")
	return s
}

// bulkDownloadBoundary is the fixed multipart boundary used on the
// bulk-download response. Matching the daemon-side handler at
// apps/daemon/pkg/toolbox/fs/download_files.go means clients that already
// parse the daemon endpoint can be pointed at the runner endpoint without
// changes.
const bulkDownloadBoundary = "BOXLITE-FILE-BOUNDARY"

// FilesBulkDownloadRequest is the JSON body for bulk-download. Defined
// locally rather than imported from apps/daemon so the runner doesn't pull
// in the daemon module just for this struct.
type FilesBulkDownloadRequest struct {
	Paths []string `json:"paths"`
}

// BoxliteFilesBulkDownload extracts many files out of a box in one
// HTTP request and streams them back as a multipart/form-data body. The
// wire contract mirrors the daemon-side endpoint at
// apps/daemon/pkg/toolbox/fs/download_files.go: each successful file
// becomes a `name="file"; filename="<path>"` part, each failure becomes a
// `name="error"; filename="<path>"` part. A single bad path never aborts
// the batch — clients must inspect per-part disposition, not HTTP status,
// to learn whether a specific file succeeded.
//
// Headers are committed (status + Content-Type) before any body byte is
// written, so late failures cannot be upgraded to a non-200 status. This
// is intentional and matches the daemon contract.
//
//	@Summary		Bulk-download many files from a box in one multipart response
//	@Description	Accepts a JSON body { "paths": [ ... ] } and returns a
//	@Description	multipart/form-data response with one part per requested
//	@Description	path. Successful files are emitted as
//	@Description	`Content-Disposition: form-data; name="file"; filename="<path>"`;
//	@Description	per-file failures (path not in box, CopyOut failure, open
//	@Description	failure) are emitted as
//	@Description	`Content-Disposition: form-data; name="error"; filename="<path>"`
//	@Description	with the error text as the part body. A single failing path
//	@Description	never aborts the batch.
//	@Tags			boxlite
//	@Accept			application/json
//	@Produce		multipart/form-data
//	@Param			boxId	path		string						true	"Box ID"
//	@Param			body	body		FilesBulkDownloadRequest	true	"Source paths inside the box"
//	@Success		200		{string}	binary						"multipart/form-data response"
//	@Failure		400		{object}	map[string]string			"empty/missing paths or invalid JSON"
//	@Failure		500		{object}	map[string]string			"runner singleton failure"
//	@Router			/v1/boxes/{boxId}/files/bulk-download [post]
func BoxliteFilesBulkDownload(ctx *gin.Context) {
	boxId := ctx.Param("boxId")
	if boxId == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "boxId is required"})
		return
	}

	var req FilesBulkDownloadRequest
	if err := ctx.BindJSON(&req); err != nil {
		// BindJSON already wrote a 400 via gin's error middleware. Don't
		// overwrite it.
		return
	}
	if len(req.Paths) == 0 {
		ctx.JSON(http.StatusBadRequest, gin.H{
			"error": "request body must be {\"paths\": [ ... ]} and non-empty",
		})
		return
	}

	fs, err := resolveBoxFS()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Construct the multipart writer and set its boundary BEFORE
	// committing the 200 + Content-Type. multipart.NewWriter does no
	// I/O until CreatePart, so a SetBoundary failure here can still be
	// reported as a 500 JSON error. Once we've called ctx.Status no
	// status upgrade is possible.
	mw := multipart.NewWriter(ctx.Writer)
	if err := mw.SetBoundary(bulkDownloadBoundary); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{
			"error": fmt.Sprintf("multipart boundary: %v", err),
		})
		return
	}

	ctx.Header("Content-Type", fmt.Sprintf("multipart/form-data; boundary=%s", bulkDownloadBoundary))
	ctx.Status(http.StatusOK)
	defer mw.Close()

	reqCtx := ctx.Request.Context()
	for _, srcPath := range req.Paths {
		// Bail early if the client has gone away — ctxWriter aborts
		// in-flight io.Copy on the *current* part, but without this
		// check we'd still spend a CopyOut per remaining path before
		// the next write noticed the disconnect.
		if err := reqCtx.Err(); err != nil {
			return
		}
		streamOneBulkDownload(reqCtx, fs, mw, boxId, srcPath)
	}
}

// streamOneBulkDownload extracts a single file from the box to a tmp file
// and streams it as one multipart part. Errors at any stage are emitted as
// an error part so the batch continues. The tmp file is removed before
// return regardless of outcome.
func streamOneBulkDownload(reqCtx context.Context, fs boxFS, mw *multipart.Writer, boxId, srcPath string) {
	tmpFile, err := os.CreateTemp("", "boxlite-bulk-download-*")
	if err != nil {
		writeBulkDownloadErrorPart(mw, srcPath, fmt.Sprintf("tmp: %v", err))
		return
	}
	tmpPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := fs.CopyOut(reqCtx, boxId, srcPath, tmpPath); err != nil {
		writeBulkDownloadErrorPart(mw, srcPath, fmt.Sprintf("copy: %v", err))
		return
	}

	f, err := os.Open(tmpPath)
	if err != nil {
		writeBulkDownloadErrorPart(mw, srcPath, fmt.Sprintf("open: %v", err))
		return
	}
	defer f.Close()

	if err := writeBulkDownloadFilePart(reqCtx, mw, srcPath, f); err != nil {
		// The file part header is already on the wire; we can't promote
		// this into an error part. Best-effort: emit a follow-up error
		// part so the client at least learns the stream truncated.
		writeBulkDownloadErrorPart(mw, srcPath, fmt.Sprintf("stream: %v", err))
	}
}

// writeBulkDownloadFilePart writes one successful file as a multipart part
// and copies its bytes through. The Content-Type is inferred from the
// extension; unknown types fall back to application/octet-stream so the
// client doesn't try to interpret arbitrary bytes as text.
//
// The part writer is wrapped in a ctxWriter so a client disconnect aborts
// the io.Copy instead of buffering the rest of a multi-GB file into the
// dead socket.
func writeBulkDownloadFilePart(reqCtx context.Context, mw *multipart.Writer, path string, r io.Reader) error {
	ctype := mime.TypeByExtension(filepath.Ext(path))
	if ctype == "" {
		ctype = "application/octet-stream"
	}

	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Type", ctype)
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, path))

	part, err := mw.CreatePart(hdr)
	if err != nil {
		return err
	}

	_, err = io.Copy(&ctxWriter{ctx: reqCtx, w: part}, r)
	return err
}

// writeBulkDownloadErrorPart emits a per-file failure as a multipart part.
// The disposition uses name="error" so clients can route per-part on the
// name field without parsing the body. Errors writing the error part are
// swallowed: we already failed to deliver this file, and a write failure
// at this point usually means the client is gone.
func writeBulkDownloadErrorPart(mw *multipart.Writer, path, text string) {
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Type", "text/plain; charset=utf-8")
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name="error"; filename="%s"`, path))
	part, err := mw.CreatePart(hdr)
	if err != nil {
		return
	}
	_, _ = io.WriteString(part, text)
}

// ctxWriter wraps an io.Writer so writes abort when the request context
// is canceled. Mirrors the daemon-side helper at
// apps/daemon/pkg/toolbox/fs/download_files.go so client disconnect doesn't
// keep us streaming bytes into a dead socket.
type ctxWriter struct {
	ctx context.Context
	w   io.Writer
}

func (cw *ctxWriter) Write(p []byte) (int, error) {
	select {
	case <-cw.ctx.Done():
		return 0, cw.ctx.Err()
	default:
	}
	return cw.w.Write(p)
}
