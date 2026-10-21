//go:build linux && roottest

// Root-only end-to-end tests of the privilege split (security review F2).
// They change /etc/sudoers*, /usr/local/sbin and /home/boxlite, so they only
// run in a throwaway container:
//
//	make test-linux
//
// which runs, in golang:1.26 as root, with sudo installed and a `boxlite`
// user (uid 1001) that has the image's NOPASSWD sudo:
//
//	go test -tags roottest -run . ./internal/privilege/
package privilege

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
	"github.com/boxlite-ai/microcloud/supervisor/internal/proc"
	"github.com/boxlite-ai/microcloud/supervisor/internal/state"
)

const (
	boxToken   = "bxt_e2e_secret_token"
	fwdSecret  = "fwd_e2e_secret"
	ctlSecret  = "ctl_e2e_secret"
	dbSecret   = "postgres://u:db_e2e_password@db/x"
	customPath = "/opt/image-tools/bin"
)

// protocol1Cmd is the Box cmd the CP sent before the split; Boxes created
// with it must still upgrade.
const protocol1Cmd = `mkdir -p ~/.microcloud; curl -fsS --max-time 20 "$BOXLITE_CP_URL/sv/bin/supervisor-linux-amd64" -o ~/.microcloud/sv.new && chmod +x ~/.microcloud/sv.new && mv ~/.microcloud/sv.new ~/.microcloud/sv; exec ~/.microcloud/sv`

func requireRootBox(t *testing.T) (uid, gid int) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root (run with `make test-linux`)")
	}
	uid, gid, _, ok := AppIdentity()
	if !ok || lookPath("sudo") == "" {
		t.Skip("needs a boxlite user and sudo (run with `make test-linux`)")
	}
	return uid, gid
}

// imageSudo restores what the BoxLite images ship: boxlite with full
// passwordless sudo, both as a drop-in and through the sudo group.
func imageSudo(t *testing.T) {
	t.Helper()
	must(t, os.WriteFile("/etc/sudoers.d/boxlite", []byte("boxlite ALL=(ALL) NOPASSWD:ALL\n"), 0o440))
	must(t, os.RemoveAll(SudoersFile))
	data, err := os.ReadFile("/etc/sudoers")
	must(t, err)
	restored := strings.ReplaceAll(string(data), disabledMark, "")
	if !strings.Contains(restored, "%sudo") {
		restored += "\n%sudo ALL=(ALL:ALL) NOPASSWD: ALL\n"
	}
	must(t, os.WriteFile("/etc/sudoers", []byte(restored), 0o440))
	_ = exec.Command("usermod", "-aG", "sudo", AppUser).Run()
	if out, err := exec.Command("sudo", "-n", "-u", AppUser, "sudo", "-n", "true").CombinedOutput(); err != nil {
		t.Fatalf("fixture: boxlite should have full sudo: %v %s", err, out)
	}
}

func cleanBox(t *testing.T) {
	t.Helper()
	for _, p := range []string{RootDir, LauncherPath, AppDir, filepath.Join(AppHome, ".microcloud")} {
		must(t, os.RemoveAll(p))
	}
	imageSudo(t)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// asBoxlite runs a shell snippet as the app user and returns its output.
func asBoxlite(t *testing.T, script string) (string, error) {
	t.Helper()
	uid, gid, _, _ := AppIdentity()
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Env = []string{"PATH=" + safePath, "HOME=" + AppHome}
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ---- 1. services run as uid 1001 and see none of the supervisor's secrets ----

func TestServiceAsAppUserCannotReadSecrets(t *testing.T) {
	uid, gid := requireRootBox(t)
	cleanBox(t)
	t.Cleanup(func() { cleanBox(t) })

	must(t, ensureRootDir())
	must(t, prepareAppDir(uid, gid))
	store, err := state.OpenSplit(RootDir, AppDir, &state.Owner{UID: uid, GID: gid})
	must(t, err)
	must(t, store.Update(func(st *state.State) { st.ForwardSecret, st.ControlSecret = fwdSecret, ctlSecret }))

	// A root process holding the token in its environment, like the supervisor.
	holder := exec.Command("sleep", "60")
	holder.Env = []string{"BOXLITE_BOX_TOKEN=" + boxToken}
	must(t, holder.Start())
	t.Cleanup(func() { holder.Process.Kill(); holder.Wait() })

	reaper := proc.NewReaper()
	go reaper.Run(t.Context())
	var mu sync.Mutex
	var lines []string
	hub := logs.NewHub(func(l api.LogLine) { mu.Lock(); lines = append(lines, l.Line); mu.Unlock() })
	script := fmt.Sprintf(`
		for f in %[1]s/state.json /proc/%[2]d/environ /proc/%[3]d/environ; do
			if cat "$f" >/dev/null 2>&1; then echo "READABLE $f"; else echo "DENIED $f"; fi
		done
		if sudo -n true 2>/dev/null; then echo SUDO-ALLOWED; else echo SUDO-DENIED; fi
		echo "UID=$(id -u) GID=$(id -g) GROUPS=$(id -G)"`, RootDir, holder.Process.Pid, os.Getpid())
	lockdownForTest(t)
	code, err := proc.RunAs(t.Context(), reaper, hub, "build", 1, store.ReleasesDir(), script, []string{"PATH=" + safePath}, &proc.Cred{UID: uint32(uid), GID: uint32(gid), Home: AppHome, Name: AppUser})
	must(t, err)
	out := strings.Join(lines, "\n")
	if code != 0 {
		t.Fatalf("probe exited %d:\n%s", code, out)
	}
	for _, want := range []string{
		"DENIED " + RootDir + "/state.json",
		fmt.Sprintf("DENIED /proc/%d/environ", holder.Process.Pid),
		fmt.Sprintf("DENIED /proc/%d/environ", os.Getpid()),
		"SUDO-DENIED",
		fmt.Sprintf("UID=%d GID=%d GROUPS=%d", uid, gid, gid),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("want %q in probe output:\n%s", want, out)
		}
	}
	if strings.Contains(out, boxToken) || strings.Contains(out, ctlSecret) {
		t.Fatalf("a secret leaked into app output:\n%s", out)
	}
}

// lockdownForTest installs a stand-in launcher and runs the real lockdown.
func lockdownForTest(t *testing.T) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Dir(LauncherPath), 0o755))
	must(t, os.WriteFile(LauncherPath, []byte("#!/bin/sh\necho launcher-ran-as=$(id -u) args=$# foo=${FOO:-unset}\n"), 0o755))
	uid, _, groups, _ := AppIdentity()
	locked, err := lockdown(Principal{User: AppUser, UID: uid, Groups: groups}, t.Logf)
	if err != nil || !locked {
		t.Fatalf("lockdown: locked=%v err=%v", locked, err)
	}
}

// ---- 2. sudo: the launcher, nothing else ------------------------------------------

func TestLockdownLeavesOnlyTheLauncher(t *testing.T) {
	requireRootBox(t)
	cleanBox(t)
	t.Cleanup(func() { cleanBox(t) })
	lockdownForTest(t)

	cases := []struct {
		script string
		ok     bool
		want   string
	}{
		{"sudo -n true", false, ""},
		{"sudo -n /bin/sh -c id", false, ""},
		{"sudo -n -u root id", false, ""},
		{"sudo -n " + LauncherPath, true, "launcher-ran-as=0 args=0 foo=unset"},
		{"FOO=bar sudo -n " + LauncherPath, true, "foo=unset"}, // env is reset
		{"sudo -n " + LauncherPath + " --evil", false, ""},     // no arguments
		{"sudo -n -E " + LauncherPath, false, ""},              // no setenv
		{"sudo -n FOO=bar " + LauncherPath, false, ""},
	}
	for _, c := range cases {
		out, err := asBoxlite(t, c.script)
		if (err == nil) != c.ok || !strings.Contains(out, c.want) {
			t.Errorf("%q as boxlite: err=%v out=%q, want ok=%v containing %q", c.script, err, out, c.ok, c.want)
		}
	}
	out, _ := exec.Command("sudo", "-n", "-l", "-U", AppUser).CombinedOutput()
	if !OnlyLauncher(string(out), LauncherPath) {
		t.Fatalf("sudo -l -U boxlite:\n%s", out)
	}
	t.Logf("sudo -l -U boxlite after lockdown:\n%s", out)
	// Idempotent: a second boot changes nothing and still verifies.
	before, _ := os.ReadFile("/etc/sudoers")
	lockdownForTest(t)
	after, _ := os.ReadFile("/etc/sudoers")
	if !bytes.Equal(before, after) {
		t.Fatal("a second lockdown rewrote /etc/sudoers")
	}
}

// ---- 3. the real Box cmd, first boot, restarts, CP down, protocol-1 upgrade ----

type fakeCP struct {
	t       *testing.T
	url     string
	binary  []byte
	mu      sync.Mutex
	binDown bool
	binGets int
	tokens  map[string]int
	lines   []string
}

func newFakeCP(t *testing.T, binary []byte) *fakeCP {
	f := &fakeCP{t: t, binary: binary, tokens: map[string]int{}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	f.url = "http://" + ln.Addr().String()
	srv := &http.Server{Handler: f}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return f
}

func snapshot(t *testing.T) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := "hello"
	must(t, tw.WriteHeader(&tar.Header{Name: "README.md", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}))
	tw.Write([]byte(body))
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func (f *fakeCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/sv/bin/") {
		if f.binDown {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		f.binGets++
		w.Write(f.binary) // every arch name gets the native build
		return
	}
	f.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]++
	switch r.URL.Path {
	case "/sv/v1/spec":
		probe := fmt.Sprintf(`for f in %[1]s/state.json %[1]s/config.json /proc/1/environ; do if cat "$f" >/dev/null 2>&1; then echo "READABLE $f"; else echo "DENIED $f"; fi; done; `+
			`for p in $(ls /proc | grep -E "^[0-9]+$"); do if grep -q %[2]s /proc/$p/environ 2>/dev/null; then echo "TOKEN-IN $p"; fi; done; `+
			`if sudo -n true 2>/dev/null; then echo SUDO-ALLOWED; else echo SUDO-DENIED; fi; `+
			`echo "SERVICE UID=$(id -u) HOME=$HOME USER=$USER PATH=$PATH DB=${DATABASE_URL:+set} TOKEN=${BOXLITE_BOX_TOKEN:-none}"; echo PROBE-DONE; exec sleep 600`, RootDir, boxToken)
		json.NewEncoder(w).Encode(map[string]any{
			"spec": map[string]any{"app": "t", "environment": "main", "version": 1, "deployment": 1,
				"runtime":  map[string]any{"image": "node", "size": "small", "build": []string{"echo BUILD UID=$(id -u) HOME=$HOME; touch built-by-$(id -un)"}},
				"services": []map[string]any{{"name": "worker", "command": probe}}},
			"deployment": 1, "forward_secret": fwdSecret, "control_secret": ctlSecret, "gateway_secret": fwdSecret,
			"env": map[string]string{"DATABASE_URL": dbSecret}, "snapshot": map[string]string{"id": "snap_1"},
		})
	case "/sv/v1/snapshots/snap_1":
		w.Write(snapshot(f.t))
	case "/sv/v1/logs":
		var batch []api.LogLine
		json.NewDecoder(r.Body).Decode(&batch)
		for _, l := range batch {
			f.lines = append(f.lines, l.Source+": "+l.Line)
		}
	case "/sv/v1/status":
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeCP) output() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.lines, "\n")
}

func (f *fakeCP) resetLines() { f.mu.Lock(); f.lines = nil; f.mu.Unlock() }

// boxCmd reads the cmd the control plane sends out of platform.ts, so this
// test exercises exactly what ships.
func boxCmd(t *testing.T) []string {
	t.Helper()
	src, err := os.ReadFile("../../../control-plane/src/platform.ts")
	if err != nil {
		t.Skipf("control-plane/src/platform.ts not mounted: %v", err)
	}
	get := func(name string) string {
		m := regexp.MustCompile(`const ` + name + ` = '([^']*)';`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found in platform.ts", name)
		}
		return string(m[1])
	}
	return []string{"sh", "-c", get("BOX_CMD_BOOT"), "microcloud-boot", get("BOX_CMD_ROOT")}
}

type box struct {
	t   *testing.T
	cp  *fakeCP
	cmd *exec.Cmd
}

// start runs argv as boxlite with the Box environment, as BoxLite does for PID 1.
func (b *box) start(argv []string) {
	b.t.Helper()
	uid, gid, _, _ := AppIdentity()
	c := exec.Command(argv[0], argv[1:]...)
	c.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin:" + customPath, "HOME=" + AppHome,
		"BOXLITE_CP_URL=" + b.cp.url, "BOXLITE_BOX_TOKEN=" + boxToken, "BOXLITE_ENV_ID=env_e2e", "SV_TRUST_USER_HEADERS=1",
	}
	c.Dir = AppHome
	c.Stdout, c.Stderr = os.Stderr, os.Stderr
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: []uint32{}}}
	must(b.t, c.Start())
	b.cmd = c
}

func (b *box) stop() {
	if b.cmd == nil {
		return
	}
	_ = syscall.Kill(-b.cmd.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() { b.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		_ = syscall.Kill(-b.cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
	// Services run in their own process groups as boxlite.
	exec.Command("pkill", "-KILL", "-u", AppUser).Run()
	b.cmd = nil
}

func (b *box) health() (api.HealthResponse, bool) {
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/.boxlite/sv/health", nil)
	req.Header.Set("X-BoxLite-Control", ctlSecret)
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return api.HealthResponse{}, false
	}
	defer resp.Body.Close()
	var h api.HealthResponse
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&h) != nil {
		return h, false
	}
	return h, true
}

func (b *box) waitLive(what string) api.HealthResponse {
	b.t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if h, ok := b.health(); ok && h.OK && strings.Contains(b.cp.output(), "PROBE-DONE") {
			return h
		}
		time.Sleep(200 * time.Millisecond)
	}
	b.t.Fatalf("%s: supervisor never went live; logs:\n%s", what, b.cp.output())
	return api.HealthResponse{}
}

// supervisorPID finds the process running the cached root binary.
func supervisorPID(t *testing.T) int {
	t.Helper()
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); err == nil && exe == filepath.Join(RootDir, binaryName) {
			return pid
		}
	}
	var seen []string
	for _, e := range entries {
		if exe, err := os.Readlink("/proc/" + e.Name() + "/exe"); err == nil {
			seen = append(seen, e.Name()+"="+exe)
		}
	}
	t.Fatalf("no process runs %s: %v", filepath.Join(RootDir, binaryName), seen)
	return 0
}

func (b *box) checkSealed(what string, h api.HealthResponse) {
	t := b.t
	t.Helper()
	if h.Version != api.ProtocolVersion || !h.Root || !h.SudoLocked {
		t.Fatalf("%s: health %+v, want version %d, root, sudo locked", what, h, api.ProtocolVersion)
	}
	out := b.cp.output()
	for _, want := range []string{
		"DENIED " + RootDir + "/state.json", "DENIED " + RootDir + "/config.json", "DENIED /proc/1/environ",
		"SUDO-DENIED", "SERVICE UID=1001 HOME=/home/boxlite USER=boxlite", "DB=set TOKEN=none",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("%s: want %q in service output:\n%s", what, want, out)
		}
	}
	for _, bad := range []string{"TOKEN-IN", "READABLE", "SUDO-ALLOWED"} {
		if strings.Contains(out, bad) {
			t.Errorf("%s: %q in service output:\n%s", what, bad, out)
		}
	}
	pid := supervisorPID(t)
	env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	must(t, err)
	if bytes.Contains(env, []byte(boxToken)) {
		t.Errorf("%s: the box token is still in the supervisor's own environ", what)
	}
	if o, err := asBoxlite(t, fmt.Sprintf("cat /proc/%d/environ", pid)); err == nil {
		t.Errorf("%s: boxlite read the supervisor's environ: %q", what, o)
	}
	if o, err := asBoxlite(t, "sudo -n true"); err == nil {
		t.Errorf("%s: boxlite still has sudo: %q", what, o)
	}
}

func buildSupervisor(t *testing.T) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), "sv")
	c := exec.Command("go", "build", "-o", out, "github.com/boxlite-ai/microcloud/supervisor")
	c.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := c.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, b)
	}
	data, err := os.ReadFile(out)
	must(t, err)
	return data
}

func TestBoxCmdEndToEnd(t *testing.T) {
	requireRootBox(t)
	argv := boxCmd(t)
	cleanBox(t)
	t.Cleanup(func() { cleanBox(t) })
	cp := newFakeCP(t, buildSupervisor(t))
	b := &box{t: t, cp: cp}
	t.Cleanup(b.stop)

	// --- first boot of a brand-new Box: boxlite has full sudo ---
	b.start(argv)
	h := b.waitLive("first boot")
	b.checkSealed("first boot", h)
	if !strings.Contains(cp.output(), "BUILD UID=1001 HOME=/home/boxlite") {
		t.Errorf("build steps must run as boxlite:\n%s", cp.output())
	}
	if fi, err := os.Lstat(filepath.Join(AppDir, "releases", "1", "built-by-boxlite")); err != nil || fi.Sys().(*syscall.Stat_t).Uid != 1001 {
		t.Errorf("release dir must be writable by and owned by boxlite: %v", err)
	}
	var cfg Config
	data, _ := os.ReadFile(filepath.Join(RootDir, configName))
	must(t, json.Unmarshal(data, &cfg))
	if cfg.Token != boxToken || !cfg.TrustUser || !strings.Contains(strings.Join(cfg.BaseEnv, " "), customPath) {
		t.Errorf("persisted config: %+v", cfg)
	}
	for _, kv := range cfg.BaseEnv {
		if strings.Contains(kv, boxToken) {
			t.Errorf("token in the services' base env: %s", kv)
		}
	}
	if !strings.Contains(cp.output(), "PATH=") || !strings.Contains(cp.output(), customPath) {
		t.Errorf("the image PATH must reach services:\n%s", cp.output())
	}
	// Secrets split at the gateway: forward opens the app path, not control.
	if code := gw(t, "/.boxlite/sv/health", "X-BoxLite-Gateway", fwdSecret); code != 403 {
		t.Errorf("forward secret on control path: %d", code)
	}
	if code := gw(t, "/", "X-BoxLite-Gateway", fwdSecret); code != 503 { // live, but no exposed service
		t.Errorf("forward secret on app path: %d", code)
	}

	// --- a second root instance (boxlite runs the launcher by hand) leaves at once ---
	out, err := asBoxlite(t, "timeout 30 sudo -n "+LauncherPath+"; echo exit=$?")
	if !strings.Contains(out, "already running") || !strings.Contains(out, "exit=0") {
		t.Errorf("second instance: %v %s", err, out)
	}
	if _, ok := b.health(); !ok {
		t.Fatal("the first supervisor must survive a second launch")
	}

	// --- restart: cmd takes the launcher path; root re-downloads ---
	b.stop()
	cp.resetLines()
	gets := cp.binGets
	b.start(argv)
	h = b.waitLive("restart")
	b.checkSealed("restart", h)
	if cp.binGets <= gets {
		t.Error("the launcher should have fetched the supervisor again")
	}
	// sudo execs the launcher directly (no pam session), so the process the
	// Box started is the supervisor itself, as PID 1 would be.
	if exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", b.cmd.Process.Pid)); exe != filepath.Join(RootDir, binaryName) {
		t.Logf("note: the Box's first process is %s, not the supervisor (sudo kept a monitor process)", exe)
	}

	// --- restart with the CP unreachable for downloads: the cached binary runs ---
	b.stop()
	cp.resetLines()
	cp.mu.Lock()
	cp.binDown = true
	cp.mu.Unlock()
	b.start(argv)
	b.checkSealed("CP down", b.waitLive("CP down"))
	cp.mu.Lock()
	cp.binDown = false
	cp.mu.Unlock()

	// --- a Box created with the protocol-1 cmd, already locked down ---
	b.stop()
	cp.resetLines()
	b.start([]string{"sh", "-c", protocol1Cmd})
	b.checkSealed("protocol-1 cmd after lockdown", b.waitLive("protocol-1 cmd after lockdown"))

	// --- a protocol-1 Box on its first upgrade: full sudo, legacy state.json in the app dir ---
	b.stop()
	cleanBox(t)
	cp.resetLines()
	must(t, os.MkdirAll(AppDir, 0o755))
	must(t, os.WriteFile(filepath.Join(AppDir, "state.json"), []byte(`{"current":0,"gateway_secret":"legacy"}`), 0o600))
	must(t, os.Chown(AppDir, 1001, 1001))
	must(t, os.Chown(filepath.Join(AppDir, "state.json"), 1001, 1001))
	b.start([]string{"sh", "-c", protocol1Cmd})
	b.checkSealed("protocol-1 upgrade", b.waitLive("protocol-1 upgrade"))
	if _, err := os.Stat(filepath.Join(AppDir, "state.json")); err == nil {
		t.Error("the legacy state.json with secrets must be removed from the app dir")
	}

	// --- planted symlinks in boxlite's home are not followed by root ---
	b.stop()
	cp.resetLines()
	must(t, os.RemoveAll(filepath.Join(AppDir, "releases")))
	_, err = asBoxlite(t, "ln -s /etc "+filepath.Join(AppDir, "releases"))
	must(t, err)
	b.start(argv)
	b.checkSealed("planted symlink", b.waitLive("planted symlink"))
	if fi, _ := os.Stat("/etc"); fi.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Fatal("/etc was chowned through a planted symlink")
	}
}

func gw(t *testing.T, path, header, value string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080"+path, nil)
	req.Header.Set(header, value)
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}
