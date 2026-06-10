package controllers

import (
	"archive/tar"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

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

	// The SDK uploads a tar archive (Content-Type: application/x-tar) so
	// that copy_in(host_dir, ...) can move trees in a single request.
	// We MUST extract the archive into a staging dir on the runner host
	// before handing it to the Go SDK's CopyInto — that lower-level call
	// expects a *real path*, not a tar file, and would otherwise dump the
	// entire .tar blob into the guest as a single binary file (which
	// silently breaks both single-file and directory uploads).
	stagingDir, err := os.MkdirTemp("", "boxlite-upload-stage-*")
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create staging dir"})
		return
	}
	defer os.RemoveAll(stagingDir)

	stagedPath, isSingleFile, err := extractTarToDir(ctx.Request.Body, stagingDir)
	if err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("failed to extract upload tar: %s", err)})
		return
	}

	// If the archive contained exactly one regular file, CopyInto its
	// extracted path (a real file) so the guest sees the file at destPath.
	// Otherwise CopyInto the staging dir as a whole — the Go SDK's
	// recursive copy handles directories natively.
	src := stagingDir
	if isSingleFile {
		src = stagedPath
	}

	if err := r.Boxlite.CopyInto(ctx.Request.Context(), boxId, src, destPath); err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("copy failed: %s", err)})
		return
	}

	ctx.Status(http.StatusNoContent)
}

// extractTarToDir reads a tar archive from r and writes every entry into
// destDir, preserving the relative layout. Returns:
//   - lastFilePath: path to the most-recently extracted file (only
//     meaningful when isSingleFile is true)
//   - isSingleFile: true when the archive contained exactly one regular
//     file entry (no directories, no symlinks, no multi-file payload).
//     This is the canonical signal for "the caller copy_in'd a single
//     file" so the upload handler can pass that exact path on to
//     CopyInto, rather than passing a wrapping directory.
//
// Entries with paths that escape destDir (zip-slip) are refused.
func extractTarToDir(r io.Reader, destDir string) (lastFilePath string, isSingleFile bool, err error) {
	tr := tar.NewReader(r)
	fileCount := 0
	otherCount := 0 // dirs, symlinks, anything that's not a regular file

	for {
		header, hdrErr := tr.Next()
		if hdrErr == io.EOF {
			break
		}
		if hdrErr != nil {
			return "", false, fmt.Errorf("tar.Next: %w", hdrErr)
		}

		// Defend against absolute paths and traversal — the SDK should
		// only ever send relative entries, but a malformed client could
		// craft an archive that writes outside destDir.
		cleanName := filepath.Clean(header.Name)
		if filepath.IsAbs(cleanName) || cleanName == ".." || (len(cleanName) >= 3 && cleanName[:3] == "../") {
			return "", false, fmt.Errorf("tar entry escapes staging dir: %q", header.Name)
		}
		target := filepath.Join(destDir, cleanName)

		switch header.Typeflag {
		case tar.TypeDir:
			if mkErr := os.MkdirAll(target, 0o755); mkErr != nil {
				return "", false, fmt.Errorf("mkdir %s: %w", target, mkErr)
			}
			otherCount++
		case tar.TypeReg, tar.TypeRegA:
			if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
				return "", false, fmt.Errorf("mkdir parent of %s: %w", target, mkErr)
			}
			f, openErr := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode&0o7777))
			if openErr != nil {
				return "", false, fmt.Errorf("create %s: %w", target, openErr)
			}
			if _, copyErr := io.Copy(f, tr); copyErr != nil {
				f.Close()
				return "", false, fmt.Errorf("write %s: %w", target, copyErr)
			}
			f.Close()
			lastFilePath = target
			fileCount++
		default:
			// symlinks, hardlinks, devices — preserve as best-effort by
			// counting them in otherCount so single-file detection stays
			// pessimistic (any non-regular entry forces "treat as dir").
			otherCount++
		}
	}

	isSingleFile = fileCount == 1 && otherCount == 0
	return lastFilePath, isSingleFile, nil
}

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
