//go:build boxlite_dev

package controllers

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

type uploadReadProbe struct{ reads int }

func (probe *uploadReadProbe) Read(_ []byte) (int, error) {
	probe.reads++
	return 0, io.EOF
}

// The child owns the Runner singleton, so unrelated controller unit tests keep
// their uninitialized-runtime setup. Both sides execute the production handler.
func TestRunnerUploadOverwritePreservesBytes(t *testing.T) {
	const child = "BOXLITE_UPLOAD_OVERWRITE_TEST_CHILD"
	if os.Getenv(child) == "" {
		for _, scenario := range []string{"preserve", "query"} {
			t.Run(scenario, func(t *testing.T) {
				cmd := exec.Command(os.Args[0], "-test.run=^TestRunnerUploadOverwritePreservesBytes$", "-test.v")
				cmd.Env = append(os.Environ(), child+"="+scenario)
				output, err := cmd.CombinedOutput()
				t.Logf("Runner upload subprocess:\n%s", output)
				if err != nil {
					t.Fatal(err)
				}
			})
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "synthetic-local-test")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: client}); err != nil {
		t.Fatal(err)
	}
	enabled := true
	cpu := 1.0
	id, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id: "upload-overwrite-proof", Image: "alpine:latest", CpuQuota: &cpu, MemoryQuota: 1, StorageQuota: 1,
		OutboundEnabled: &enabled, Entrypoint: []string{"sleep"}, Cmd: []string{"infinity"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stopCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCleanup()
		if err := client.Stop(cleanup, id, true); err != nil {
			t.Errorf("stop: %v", err)
		}
		if err := client.Destroy(cleanup, id); err != nil {
			t.Errorf("destroy: %v", err)
		}
	}()
	if _, err := client.Start(ctx, id, nil, nil); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	const destination = "/root/upload-overwrite.txt"
	upload := func(query, content string) *httptest.ResponseRecorder {
		var data bytes.Buffer
		writer := tar.NewWriter(&data)
		if err := writer.WriteHeader(&tar.Header{Name: "source.txt", Mode: 0644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		request, _ := gin.CreateTestContext(recorder)
		request.Params = gin.Params{{Key: "boxId", Value: id}}
		request.Request = httptest.NewRequest(http.MethodPut, "/files?path="+destination+query, &data).WithContext(ctx)
		BoxliteFileUpload(request)
		request.Writer.WriteHeaderNow()
		return recorder
	}
	read := func() string {
		result, err := client.Exec(ctx, id, "cat", destination)
		if err != nil {
			t.Fatal(err)
		}
		if result.ExitCode != 0 {
			t.Fatalf("read original: exit=%d stderr=%q", result.ExitCode, result.StdErr)
		}
		return result.StdOut
	}
	if response := upload("&overwrite=false", "original"); response.Code != http.StatusNoContent {
		t.Fatalf("create missing destination: HTTP %d %s", response.Code, response.Body.String())
	}
	if os.Getenv(child) == "preserve" {
		refused := upload("&overwrite=false", "replacement")
		if refused.Code < 400 || !strings.Contains(refused.Body.String(), "overwrite=false") {
			t.Fatalf("expected overwrite=false refusal, HTTP %d %s; stored=%q", refused.Code, refused.Body.String(), read())
		}
		if got := read(); got != "original" {
			t.Fatalf("original changed after refusal: %q", got)
		}
	}
	for _, query := range []string{
		"&overwrite=", "&overwrite=nonsense", "&overwrite=false&overwrite=true",
		"&overwrite=%ZZ", "&overwrite=false;bad", "&overwrite=false&overwrite=%ZZ",
	} {
		t.Run(query, func(t *testing.T) {
			body := &uploadReadProbe{}
			recorder := httptest.NewRecorder()
			request, _ := gin.CreateTestContext(recorder)
			request.Params = gin.Params{{Key: "boxId", Value: id}}
			request.Request = httptest.NewRequest(http.MethodPut, "/files?path="+destination+query, body).WithContext(ctx)
			BoxliteFileUpload(request)
			request.Writer.WriteHeaderNow()
			if recorder.Code != http.StatusBadRequest {
				t.Errorf("invalid query probe: HTTP %d %s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 {
				t.Errorf("invalid query read the archive %d times", body.reads)
			}
			if response := upload("&overwrite=true", "original"); response.Code != http.StatusNoContent {
				t.Fatalf("seed original: HTTP %d %s", response.Code, response.Body.String())
			}
			if response := upload(query, "invalid"); response.Code != http.StatusBadRequest {
				t.Fatalf("invalid query %q: HTTP %d %s; stored=%q", query, response.Code, response.Body.String(), read())
			}
			if got := read(); got != "original" {
				t.Fatalf("invalid query changed original: %q", got)
			}
		})
	}
	for _, query := range []string{"&overwrite=true", ""} {
		if response := upload(query, "allowed"); response.Code != http.StatusNoContent {
			t.Fatalf("allowed replacement %q: HTTP %d %s", query, response.Code, response.Body.String())
		}
		if got := read(); got != "allowed" {
			t.Fatalf("replacement bytes=%q", got)
		}
	}
}
