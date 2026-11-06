//go:build boxlite_dev

package boxlite

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// Run with BOXLITE_TEST_KERNEL set to the DinD ELF and retain go test -v output.
// Both Docker Engine and Compose execute inside a Runner-created privileged Box.
func TestIntegrationRunnerDocker(t *testing.T) {
	kernel := os.Getenv("BOXLITE_TEST_KERNEL")
	if kernel == "" {
		t.Skip("set BOXLITE_TEST_KERNEL to the pinned DinD ELF")
	}
	home := os.Getenv("BOXLITE_TEST_KERNEL_HOME")
	if home == "" {
		var err error
		home, err = os.MkdirTemp("", "boxlite-runner-dind-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if t.Failed() {
				return
			}
			if err := os.RemoveAll(home); err != nil {
				t.Errorf("remove test home: %v", err)
			}
		})
	} else {
		home = filepath.Join(home, "docker")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	client, err := NewClient(ctx, ClientConfig{HomeDir: home, KernelPath: kernel})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	marker := fmt.Sprintf("runner-dind-%x", time.Now().UnixNano())
	env := map[string]string{"DOCKER_TLS_CERTDIR": ""}
	if proxy := os.Getenv("BOXLITE_ACCEPTANCE_DOWNLOAD_PROXY"); proxy != "" {
		for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
			env[key] = proxy
		}
		env["NO_PROXY"] = "localhost,127.0.0.1,backend"
		env["no_proxy"] = env["NO_PROXY"]
	}
	t.Logf("Runner Client.Create name=%s image=docker:27.5.1-dind privileged=true kernel=%s home=%s", marker, kernel, home)
	id, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id: marker, Image: "docker:27.5.1-dind", CpuQuota: 2, MemoryQuota: 2, StorageQuota: 5,
		Privileged: true, OutboundEnabled: boolPtr(true), Env: env,
		Entrypoint: []string{"sh", "-c"}, Cmd: []string{"exec sleep infinity"},
	})
	defer func() {
		if t.Failed() {
			diagnostics, cancelDiagnostics := context.WithTimeout(context.Background(), 30*time.Second)
			box, err := client.getOrFetchBox(diagnostics, marker)
			if err != nil {
				t.Logf("Docker diagnostics: lookup error=%v", err)
			} else {
				result, err := box.Exec(diagnostics, "sh", "-c", "cat /tmp/dockerd.log; docker info; docker ps -a")
				t.Logf("Docker diagnostics: result=%+v error=%v", result, err)
			}
			cancelDiagnostics()
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		stopErr := client.Stop(cleanup, marker, false)
		if stopErr != nil {
			t.Errorf("stop: %v", stopErr)
		}
		if t.Failed() {
			t.Logf("failed Box retained: name=%s home=%s stop_error=%v", marker, home, stopErr)
			return
		}
		if err := client.runtime.ForceRemove(cleanup, marker); err != nil {
			t.Errorf("remove: %v", err)
		}
	}()
	if err != nil {
		t.Fatalf("Runner Client.Create: %v", err)
	}
	box, err := client.getOrFetchBox(ctx, marker)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(home, "boxes", id, "boot", "current.json"))
	if err != nil {
		t.Fatal(err)
	}
	var boot struct {
		KernelSHA256 string `json:"kernel_sha256"`
	}
	if err := json.Unmarshal(manifest, &boot); err != nil {
		t.Fatal(err)
	}
	const pinned = "sha256:3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"
	if boot.KernelSHA256 != pinned {
		t.Fatalf("boot manifest: %s", manifest)
	}
	t.Logf("box=%s boot=%s", id, manifest)
	run := func(command string) string {
		t.Helper()
		t.Logf("box=%s command=%s", id, command)
		result, err := box.Exec(ctx, "sh", "-c", "set -eu; "+command)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("exit=%d stdout=%s stderr=%s", result.ExitCode, result.Stdout, result.Stderr)
		if result.ExitCode != 0 {
			t.Fatalf("guest command exited %d", result.ExitCode)
		}
		return result.Stdout
	}
	run("nohup dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --dns-search=. >/tmp/dockerd.log 2>&1 </dev/null &")
	run(`i=0; until docker info >/tmp/docker-info 2>&1; do i=$((i+1)); if [ "$i" -ge 90 ]; then cat /tmp/docker-info /tmp/dockerd.log; exit 1; fi; sleep 1; done; cat /tmp/docker-info`)
	run(`uname -a; docker version; docker compose version; test -S /var/run/docker.sock; test -z "${DOCKER_HOST:-}"; test "$(docker info --format '{{.Driver}}')" = overlay2; test "$(docker info --format '{{.DockerRootDir}}')" = /var/lib/docker; ! grep -q ' /var/run/docker.sock ' /proc/mounts`)
	const base = "busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
	run("docker pull " + base)
	run("mkdir -p /opt/runner-proof/build")
	buildDir := t.TempDir()
	for name, contents := range map[string]string{
		"marker":     marker,
		"Dockerfile": "FROM " + base + "\nCOPY marker /srv/index.html\nRUN test -s /srv/index.html\nCMD [\"cat\",\"/srv/index.html\"]\n",
	} {
		path := filepath.Join(buildDir, name)
		if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
		if err := box.CopyInto(ctx, path, "/opt/runner-proof/build/"+name); err != nil {
			t.Fatal(err)
		}
	}
	run("docker build --progress=plain -t runner-proof:local /opt/runner-proof/build")
	if got := strings.TrimSpace(run("docker run --rm --pull=never runner-proof:local")); got != marker {
		t.Fatalf("D1 image content=%q, want %q", got, marker)
	}
	t.Logf("D1 PASS box=%s marker=%s", id, marker)
	compose := "services:\n  backend:\n    image: runner-proof:local\n    pull_policy: never\n    command: [httpd, -f, -p, '8080', -h, /srv]\n  client:\n    image: " + base + "\n    pull_policy: never\n    command: [tail, -f, /dev/null]\n"
	path := filepath.Join(buildDir, "compose.yaml")
	if err := os.WriteFile(path, []byte(compose), 0600); err != nil {
		t.Fatal(err)
	}
	if err := box.CopyInto(ctx, path, "/opt/runner-proof/compose.yaml"); err != nil {
		t.Fatal(err)
	}
	const composeCommand = "docker compose -p runner-proof -f /opt/runner-proof/compose.yaml"
	run(composeCommand + " up -d")
	run(composeCommand + ` exec -T client sh -c 'test -z "${http_proxy:-}${https_proxy:-}${HTTP_PROXY:-}${HTTPS_PROXY:-}"'`)
	got := strings.TrimSpace(run(composeCommand + ` exec -T client sh -c 'i=0; until wget -T 5 -SO /tmp/body http://backend:8080/ 2>/tmp/headers; do i=$((i+1)); if [ "$i" -ge 30 ]; then cat /tmp/headers >&2; exit 1; fi; sleep 1; done; cat /tmp/headers >&2; grep -q "HTTP/1.[01] 200" /tmp/headers; cat /tmp/body'`))
	if got != marker {
		t.Fatalf("D2 Compose HTTP content=%q, want %q", got, marker)
	}
	run(composeCommand + " ps --format json; docker network inspect runner-proof_default; cat /tmp/dockerd.log")
	run(composeCommand + " down")
	t.Logf("D2 PASS box=%s marker=%s", id, marker)
}
