package controllers

import (
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

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
	r, err := runner.GetInstance(nil)
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

	if err := r.Boxlite.CopyInto(ctx.Request.Context(), boxId, tmpFile.Name(), destPath); err != nil {
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
	r, err := runner.GetInstance(nil)
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

	// CopyOut's auto-detect treats a non-existent dest as file-to-file when
	// the tar carries exactly one regular file. Create the tmp file, then
	// remove it so the dest path exists in the namespace but not on disk —
	// CopyOut overwrites it with the box's file bytes.
	tmpFile, err := os.CreateTemp("", "boxlite-download-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp file"})
		return
	}
	tmpPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := r.Boxlite.CopyOut(ctx.Request.Context(), boxId, srcPath, tmpPath); err != nil {
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
// otherwise-valid batch. This mirrors the daemon-side handler at
// apps/daemon/pkg/toolbox/fs/upload_files.go and the Daytona endpoint
// it was modelled on (proxy.app.daytona.io/toolbox/{id}/files/bulk-upload),
// the original motivation being "hundreds of small files at sandbox init".
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
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, s := range staged {
			if err := r.Boxlite.CopyInto(ctx.Request.Context(), boxId, s.Src, s.Dest); err != nil {
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
			data, readErr := io.ReadAll(part)
			part.Close()
			if readErr != nil {
				errs = append(errs, fmt.Sprintf("path[%s]: %v", idx, readErr))
				continue
			}
			dest := strings.TrimSpace(string(data))
			if dest == "" {
				errs = append(errs, fmt.Sprintf("path[%s]: empty", idx))
				continue
			}
			dests[idx] = dest

		case strings.HasSuffix(name, ".file"):
			dest, ok := dests[idx]
			if !ok {
				part.Close()
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
	if _, err := io.Copy(f, part); err != nil {
		f.Close()
		_ = os.Remove(name)
		return "", fmt.Errorf("write: %w", err)
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
