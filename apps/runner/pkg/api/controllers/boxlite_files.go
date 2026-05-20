package controllers

import (
	"archive/tar"
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
// body into a path inside the box.
//
//	@Summary	Upload a file to a box
//	@Tags		boxlite
//	@Accept		application/octet-stream
//	@Produce	json
//	@Param		boxId	path	string	true	"Box ID"
//	@Param		path	query	string	true	"Destination path inside the box"
//	@Success	204
//	@Failure	400	{object}	map[string]string	"bad request"
//	@Failure	500	{object}	map[string]string	"internal error"
//	@Router		/v1/boxes/{boxId}/files [put]
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

	tmpFile, err := os.CreateTemp("", "boxlite-upload-*.tar")
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

// BoxliteFileDownload reads a path out of the box and streams it back as
// a tar archive.
//
//	@Summary	Download a file or directory from a box as a tar stream
//	@Tags		boxlite
//	@Produce	application/x-tar
//	@Param		boxId	path		string				true	"Box ID"
//	@Param		path	query		string				true	"Source path inside the box"
//	@Success	200		{string}	binary				"tar archive of the requested path"
//	@Failure	400		{object}	map[string]string	"bad request"
//	@Failure	500		{object}	map[string]string	"internal error"
//	@Router		/v1/boxes/{boxId}/files [get]
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

	tmpDir, err := os.MkdirTemp("", "boxlite-download-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp dir"})
		return
	}
	defer os.RemoveAll(tmpDir)

	if err := r.Boxlite.CopyOut(ctx.Request.Context(), boxId, srcPath, tmpDir); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}

	ctx.Header("Content-Type", "application/x-tar")
	ctx.Status(http.StatusOK)

	tw := tar.NewWriter(ctx.Writer)
	defer tw.Close()

	filepath.Walk(tmpDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		relPath, _ := filepath.Rel(tmpDir, path)
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = relPath
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
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
