//go:build boxlite_dev

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// Explicit input keeps ordinary unit runs independent of a downloaded kernel.
// This test boots through the Runner -> Go -> C -> Rust path, with sandboxing on.
func TestIntegrationRunnerExternalKernel(t *testing.T) {
	kernel := os.Getenv("BOXLITE_TEST_KERNEL")
	if kernel == "" {
		t.Skip("set BOXLITE_TEST_KERNEL to the pinned DinD ELF")
	}
	bytes, err := os.ReadFile(kernel)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bytes)
	const pinned = "3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"
	if hex.EncodeToString(digest[:]) != pinned {
		t.Fatal("unexpected DinD kernel SHA256")
	}
	home := os.Getenv("BOXLITE_TEST_KERNEL_HOME")
	if home == "" {
		home = t.TempDir()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	client, err := NewClient(ctx, ClientConfig{HomeDir: home, KernelPath: kernel})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, privileged := range []bool{false, true} {
		name := "external-kernel-ordinary"
		if privileged {
			name = "external-kernel-privileged"
		}
		t.Run(name, func(t *testing.T) {
			id, _, err := client.Create(ctx, dto.CreateBoxDTO{
				Id: name, Image: "alpine:3.21", CpuQuota: 1, MemoryQuota: 1, StorageQuota: 2,
				Entrypoint: []string{"sleep"}, Cmd: []string{"infinity"},
				Privileged: privileged, OutboundEnabled: boolPtr(true),
			})
			if err != nil {
				t.Fatal(err)
			}
			box, err := client.getOrFetchBox(ctx, name)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := client.Stop(cleanup, name, false); err != nil {
					t.Errorf("stop: %v", err)
				}
				if err := client.runtime.ForceRemove(cleanup, id); err != nil {
					t.Errorf("remove: %v", err)
				}
			}()
			run := func(command string) string {
				t.Helper()
				result, err := box.Exec(ctx, "sh", "-c", "set -eu; "+command+"; sleep 0.1")
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("command=%s exit=%d stdout=%s stderr=%s", command, result.ExitCode, result.Stdout, result.Stderr)
				if result.ExitCode != 0 {
					t.Fatalf("command failed: %s", result.Stderr)
				}
				return result.Stdout
			}
			if got := strings.TrimSpace(run("uname -r")); got != "6.12.87" {
				t.Fatalf("kernel=%q", got)
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
			if boot.KernelSHA256 != "sha256:"+pinned {
				t.Fatalf("boot manifest: %s", manifest)
			}
			t.Logf("box=%s privileged=%v boot=%s", id, privileged, manifest)
			if privileged {
				apks, err := filepath.Glob(filepath.Join(os.Getenv("BOXLITE_TEST_KERNEL_APKS"), "*.apk"))
				if err != nil || len(apks) == 0 {
					t.Fatal("BOXLITE_TEST_KERNEL_APKS must contain iproute2/ipvsadm packages")
				}
				run("mkdir -p /opt/kernel-probe")
				for _, apk := range apks {
					if err := box.CopyInto(ctx, apk, "/opt/kernel-probe/"+filepath.Base(apk)); err != nil {
						t.Fatal(err)
					}
				}
				run("apk add --no-network /opt/kernel-probe/*.apk")
				if !strings.Contains(run("ip link add proof-vx type vxlan id 4210 dev eth0 dstport 4789; ip -d link show proof-vx; ip link del proof-vx"), "vxlan id 4210") {
					t.Fatal("VXLAN missing")
				}
				for _, protocol := range []string{"t", "u"} {
					out := run("ipvsadm -A -" + protocol + " 10.255.254.1:9999 -s rr; ipvsadm -Ln; ipvsadm -D -" + protocol + " 10.255.254.1:9999")
					if !strings.Contains(out, "10.255.254.1:9999 rr") {
						t.Fatal("IPVS missing")
					}
				}
			}
			if err := client.Stop(ctx, name, false); err != nil {
				t.Fatal(err)
			}
			if _, err := client.Start(ctx, name, nil, nil); err != nil {
				t.Fatal(err)
			}
			box, err = client.getOrFetchBox(ctx, name)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(run("uname -r")); got != "6.12.87" {
				t.Fatalf("restart kernel=%q", got)
			}
		})
	}
}
