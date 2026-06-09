package controllers

import (
	"archive/tar"
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// One real box is shared by every copy-parity case in this file. runner.GetInstance
// seeds a process-global singleton that errors on re-seed, and macOS unix sockets
// must stay under SUN_LEN — so a single short-path box created in TestMain is the
// only workable shape. Each case writes/reads its own paths inside the box.
var sharedCopyEnv *copyTestEnv

type copyTestEnv struct {
	client *blclient.Client
	boxID  string
}

// TestMain owns the real box + runner singleton for the whole package run.
// Short HomeDir under /tmp keeps the box's ready.sock path within SUN_LEN.
func TestMain(m *testing.M) {
	flag.Parse() // required before testing.Short() is readable
	if testing.Short() {
		os.Exit(m.Run())
	}
	ctx := context.Background()

	homeDir, err := os.MkdirTemp("/tmp", "blcp")
	if err != nil {
		fmt.Fprintf(os.Stderr, "mkdir home: %v\n", err)
		os.Exit(1)
	}

	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: homeDir})
	if err != nil {
		fmt.Fprintf(os.Stderr, "NewClient: %v\n", err)
		os.RemoveAll(homeDir)
		os.Exit(1)
	}
	id := "cp-it-" + time.Now().Format("150405")
	// Create auto-starts the box; do NOT call Start. Memory/Storage are GB.
	if _, _, err := client.Create(ctx, dto.CreateSandboxDTO{
		Id: id, UserId: "test", Snapshot: "alpine:latest", OsUser: "root",
		CpuQuota: 1, MemoryQuota: 1, StorageQuota: 2,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Create: %v\n", err)
		_ = client.Close()
		os.RemoveAll(homeDir)
		os.Exit(1)
	}
	if _, err := runner.GetInstance(&runner.RunnerInstanceConfig{Boxlite: client}); err != nil {
		fmt.Fprintf(os.Stderr, "seed runner: %v\n", err)
		_ = client.Stop(ctx, id, false)
		_ = client.Close()
		os.RemoveAll(homeDir)
		os.Exit(1)
	}
	sharedCopyEnv = &copyTestEnv{client: client, boxID: id}

	code := m.Run()

	// Stop (not Destroy): Destroy -> removeSandboxVolumeMountRecord ->
	// config.GetEnvironment() nil-derefs because the runner config global is
	// never loaded in unit-test processes. Stop tears down the VM cleanly.
	_ = client.Stop(ctx, id, false)
	_ = client.Close()
	os.RemoveAll(homeDir)
	os.Exit(code)
}

// copyEnv returns the shared real box, skipping the case in -short mode where
// TestMain never built one.
func copyEnv(t *testing.T) *copyTestEnv {
	t.Helper()
	if testing.Short() {
		t.Skip("real-box copy integration test; skipped in -short")
	}
	if sharedCopyEnv == nil {
		t.Fatal("shared copy env not initialized (box boot failed in TestMain)")
	}
	return sharedCopyEnv
}

func tarOf(t *testing.T, name, content string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	return &buf
}

func (e *copyTestEnv) upload(t *testing.T, query string, body io.Reader) int {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.PUT("/v1/boxes/:boxId/files", BoxliteFileUpload)
	req := httptest.NewRequest(http.MethodPut, "/v1/boxes/"+e.boxID+"/files?"+query, body)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code
}

func (e *copyTestEnv) download(t *testing.T, query string) (int, *bytes.Buffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/v1/boxes/:boxId/files", BoxliteFileDownload)
	req := httptest.NewRequest(http.MethodGet, "/v1/boxes/"+e.boxID+"/files?"+query, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w.Code, w.Body
}

func (e *copyTestEnv) boxCat(t *testing.T, path string) string {
	t.Helper()
	res, err := e.client.Exec(context.Background(), e.boxID, "/bin/sh", "-c", "cat '"+path+"' 2>/dev/null")
	if err != nil {
		t.Fatalf("exec cat: %v", err)
	}
	return res.StdOut
}

// G2: copy_in must EXTRACT the tar; the box gets the FILE, not a tar.
func TestCloudCopyInExtractsTar(t *testing.T) {
	e := copyEnv(t)
	q := "path=" + url.QueryEscape("/root/one.txt")
	if code := e.upload(t, q, tarOf(t, "one.txt", "hello-one")); code != http.StatusNoContent {
		t.Fatalf("upload: got %d, want 204", code)
	}
	if got := e.boxCat(t, "/root/one.txt"); got != "hello-one" {
		t.Fatalf("box /root/one.txt = %q, want hello-one (tar not extracted?)", got)
	}
}

// G1/F-010: box file downloads as a tar containing the file at its basename.
func TestCloudCopyOutFileF010(t *testing.T) {
	e := copyEnv(t)
	if _, err := e.client.Exec(context.Background(), e.boxID, "/bin/sh", "-c", "printf boxdata >/root/out.txt"); err != nil {
		t.Fatal(err)
	}
	code, body := e.download(t, "path="+url.QueryEscape("/root/out.txt")+"&include_parent=false")
	if code != http.StatusOK {
		t.Fatalf("download: got %d, want 200", code)
	}
	if got := tarEntry(t, body, "out.txt"); got != "boxdata" {
		t.Fatalf("downloaded out.txt = %q, want boxdata", got)
	}
}

// G3: copy_out of a dir with an EMPTY subdir and a SYMLINK preserves both.
func TestCloudCopyOutPreservesEmptyDirAndSymlink(t *testing.T) {
	e := copyEnv(t)
	if _, err := e.client.Exec(context.Background(), e.boxID, "/bin/sh", "-c",
		"mkdir -p /root/d/empty && printf data >/root/d/target.txt && ln -sf target.txt /root/d/link.txt"); err != nil {
		t.Fatal(err)
	}
	code, body := e.download(t, "path="+url.QueryEscape("/root/d")+"&include_parent=true")
	if code != http.StatusOK {
		t.Fatalf("download: got %d, want 200", code)
	}
	names, links := tarIndex(t, body)
	if !names["d/empty/"] {
		t.Errorf("empty dir d/empty/ missing from tar (names=%v)", names)
	}
	if links["d/link.txt"] != "target.txt" {
		t.Errorf("symlink d/link.txt not preserved (target=%q)", links["d/link.txt"])
	}
}

func tarEntry(t *testing.T, buf *bytes.Buffer, name string) string {
	t.Helper()
	tr := tar.NewReader(buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			t.Fatalf("entry %q not found in tar", name)
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == name {
			b, _ := io.ReadAll(tr)
			return string(b)
		}
	}
}

func tarIndex(t *testing.T, buf *bytes.Buffer) (map[string]bool, map[string]string) {
	t.Helper()
	names := map[string]bool{}
	links := map[string]string{}
	tr := tar.NewReader(buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return names, links
		}
		if err != nil {
			t.Fatal(err)
		}
		names[h.Name] = true
		if h.Typeflag == tar.TypeSymlink {
			links[h.Name] = h.Linkname
		}
	}
}
