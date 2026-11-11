//go:build boxlite_dev

package controllers

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	client "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

func TestIntegrationUploadOverwriteHTTP(t *testing.T) {
	ctx := context.Background()
	// Initialize the environment used by volume cleanup, without external services.
	_, _ = config.GetConfig()
	runtime, err := client.NewClient(ctx, client.ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		var runtimeErr *sdk.Error
		if errors.As(err, &runtimeErr) && runtimeErr.Code == sdk.ErrUnsupported {
			t.Skipf("virtualization prerequisite unavailable: %v", err)
		}
		t.Fatal(err)
	}
	defer runtime.Close()
	enabled := false
	cpuQuota := 1.0
	_, _, err = runtime.Create(ctx, dto.CreateBoxDTO{Id: "upload-protection", Image: "alpine:latest", CpuQuota: &cpuQuota, MemoryQuota: 1, StorageQuota: 2, OutboundEnabled: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Destroy(ctx, "upload-protection")
	r, err := runner.GetInstance(nil)
	if err != nil {
		r, err = runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: runtime})
		if err != nil {
			t.Fatal(err)
		}
	}
	previous := r.Boxlite
	r.Boxlite = runtime
	defer func() { r.Boxlite = previous }()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.PUT("/v1/boxes/:boxId/files", BoxliteFileUpload)
	router.GET("/v1/boxes/:boxId/files", BoxliteFileDownload)
	archive := func(content string) []byte {
		var data bytes.Buffer
		w := tar.NewWriter(&data)
		if err := w.WriteHeader(&tar.Header{Name: "keep.txt", Mode: 0o644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		return data.Bytes()
	}
	upload := func(query, content string, want int) {
		t.Helper()
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/v1/boxes/upload-protection/files?path=/root&source_is_dir=true"+query, bytes.NewReader(archive(content))))
		if response.Code != want {
			t.Fatalf("upload %s: %d %s", query, response.Code, response.Body.String())
		}
	}
	upload("", "original", 204)
	upload("&overwrite=false", "replacement", 409)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/boxes/upload-protection/files?path=/root/keep.txt", nil))
	if response.Code != 200 {
		t.Fatalf("download: %d %s", response.Code, response.Body.String())
	}
	reader := tar.NewReader(bytes.NewReader(response.Body.Bytes()))
	if _, err := reader.Next(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if err != nil || string(data) != "original" {
		t.Fatalf("guest bytes=%q err=%v", data, err)
	}
	upload("&overwrite=true", "replacement", 204)
}
