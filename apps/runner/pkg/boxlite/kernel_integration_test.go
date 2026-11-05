//go:build boxlite_dev

package boxlite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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
	const pinned = "3c6cfc8015a1ba05cebabecd37967d665f2a0f81424b69f8d43d6e87feaceb92"
	const seedRun = "BOXLITE_TEST_KERNEL_SEED_RUN"
	runID := os.Getenv(seedRun)
	seed := runID != ""
	home := os.Getenv("BOXLITE_TEST_KERNEL_HOME")
	if !seed {
		bytes, err := os.ReadFile(kernel)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(bytes)
		if hex.EncodeToString(digest[:]) != pinned {
			t.Fatal("unexpected DinD kernel SHA256")
		}
		if home == "" {
			home, err = os.MkdirTemp("", "boxlite-runner-kernel-")
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
			home = filepath.Join(home, "kernel")
		}
		t.Logf("Runner external kernel: kernel=%s home=%s", kernel, home)
		runID = fmt.Sprintf("%x", time.Now().UnixNano())
		// The original Runner process must exit before its successor opens this home.
		cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestIntegrationRunnerExternalKernel$", "-test.v")
		cmd.Env = append(os.Environ(), seedRun+"="+runID, "BOXLITE_TEST_KERNEL_HOME="+home)
		output, err := cmd.CombinedOutput()
		t.Logf("initial Runner process:\n%s", output)
		if err != nil {
			t.Fatal(err)
		}
	}
	client, err := NewClient(t.Context(), ClientConfig{HomeDir: home, KernelPath: kernel})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, privileged := range []bool{false, true} {
		name := "external-kernel-ordinary"
		if privileged {
			name = "external-kernel-privileged"
		}
		name += "-" + runID
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			var err error
			if seed {
				_, _, err = client.Create(ctx, dto.CreateBoxDTO{
					Id: name, Image: "alpine:3.21", CpuQuota: 1, MemoryQuota: 1, StorageQuota: 2,
					Entrypoint: []string{"sleep"}, Cmd: []string{"infinity"},
					Privileged: privileged, OutboundEnabled: boolPtr(true),
				})
			} else {
				_, err = client.Start(ctx, name, nil, nil)
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				stopErr := client.Stop(cleanup, name, false)
				if stopErr != nil {
					t.Errorf("stop: %v", stopErr)
				}
				if t.Failed() {
					t.Logf("failed Box retained: name=%s home=%s stop_error=%v", name, home, stopErr)
					return
				}
				if !seed {
					if err := client.runtime.ForceRemove(cleanup, name); err != nil {
						t.Errorf("remove: %v", err)
					}
				}
			}()
			if err != nil {
				t.Fatal(err)
			}
			box, err := client.getOrFetchBox(ctx, name)
			if err != nil {
				t.Fatal(err)
			}
			id := box.ID()
			run := func(command string) string {
				t.Helper()
				result, err := box.Exec(ctx, "sh", "-c", "set -eu; "+command)
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
			if !seed {
				t.Logf("reconstructed Client restarted box=%s name=%s kernel=6.12.87", id, name)
				return
			}
			if privileged {
				if packages := os.Getenv("BOXLITE_TEST_KERNEL_APKS"); packages != "" {
					apks, err := filepath.Glob(filepath.Join(packages, "*.apk"))
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
				} else {
					run("apk add --no-cache iproute2 ipvsadm")
				}
				run("apk info -v")
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
