// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	runnerSymlink = "/usr/local/bin/boxlite-runner"
	releasesDir   = "/usr/local/lib/boxlite-runner/releases"
	installedFile = "/usr/local/lib/boxlite-runner/installed.json"
	dropInPath    = "/etc/systemd/system/%s.service.d/runtime-dir.conf"
)

// Host is everything the reconcile does to this machine: systemd units,
// release directories, the runtime cache, and the runner's own HTTP API.
//
// It holds no rollout policy — Reconciler decides what to do, Host knows how.
type Host struct {
	service string
	env     serviceEnv
	client  *http.Client
}

// serviceEnv is the subset of the runner unit's environment the rollout needs.
// Reading it from the live unit rather than re-deriving it keeps the agent
// correct when user-data changes a port or home directory.
type serviceEnv struct {
	apiPort   int
	homeDir   string
	token     string
	enableTLS bool
}

func NewHost(service string) (*Host, error) {
	env, err := readServiceEnv(service)
	if err != nil {
		return nil, err
	}
	return &Host{
		service: service,
		env:     env,
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				// The runner's TLS listener uses a self-signed cert; this
				// client only ever talks to 127.0.0.1 on this host.
				TLSClientConfig: &tls.Config{InsecureSkipVerify: env.enableTLS},
			},
		},
	}, nil
}

func readServiceEnv(service string) (serviceEnv, error) {
	out, err := exec.Command("systemctl", "show", service, "--property=Environment", "--value").Output()
	if err != nil {
		return serviceEnv{}, fmt.Errorf("read %s environment: %w", service, err)
	}

	env := serviceEnv{apiPort: 8080, homeDir: "/var/lib/boxlite"}
	var apiTokenFallback string
	for _, kv := range strings.Fields(string(out)) {
		key, value, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch key {
		case "API_PORT":
			if port, err := strconv.Atoi(value); err == nil {
				env.apiPort = port
			}
		case "BOXLITE_HOME_DIR":
			env.homeDir = value
		case "BOXLITE_RUNNER_TOKEN":
			env.token = value
		case "API_TOKEN":
			apiTokenFallback = value
		case "ENABLE_TLS":
			env.enableTLS = value == "true"
		}
	}
	if env.token == "" {
		env.token = apiTokenFallback
	}
	if env.token == "" {
		return serviceEnv{}, fmt.Errorf("no BOXLITE_RUNNER_TOKEN/API_TOKEN in the %s environment", service)
	}
	return env, nil
}

func (h *Host) baseURL() string {
	if h.env.enableTLS {
		return fmt.Sprintf("https://127.0.0.1:%d", h.env.apiPort)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", h.env.apiPort)
}

// ── release directories ──────────────────────────────────────────────────────
// Each build lives in its own directory with a hash sidecar, and the live
// binary is a symlink into one of them. That is what makes rollback a symlink
// swap instead of restoring a .bak that may or may not still be the binary it
// was when it was saved.

func (h *Host) InstallRelease(version, sourceBinary string) (string, error) {
	dir := filepath.Join(releasesDir, "v"+version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(dir, "boxlite-runner")
	if err := copyFile(sourceBinary, target, 0o755); err != nil {
		return "", err
	}
	sum, err := fileSHA256(target)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(target+".sha256", []byte(sum+"\n"), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// VerifyRelease re-hashes an install target against its sidecar. Run on both
// the incoming build and the rollback target *before* the unit is stopped, so
// a corrupt rollback target is discovered while the runner is still up.
func (h *Host) VerifyRelease(target, label string) error {
	info, err := os.Stat(target)
	if err != nil {
		return fmt.Errorf("%s release target %s: %w", label, target, err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s release target %s is not executable", label, target)
	}

	actual, err := fileSHA256(target)
	if err != nil {
		return err
	}
	sidecar := target + ".sha256"
	expected, err := readFirstField(sidecar)
	if os.IsNotExist(err) {
		// A pre-existing install from before versioned releases has no
		// sidecar. Record what is there so the next rollback can verify it,
		// rather than refusing to roll back at all.
		return os.WriteFile(sidecar, []byte(actual+"\n"), 0o644)
	}
	if err != nil {
		return err
	}
	if expected != actual {
		return fmt.Errorf("%s release target %s hash mismatch: want %s got %s", label, target, expected, actual)
	}
	return nil
}

// CurrentTarget resolves the live binary to its release directory. A plain
// binary left by an older install is adopted into a release directory first so
// it can serve as a rollback target.
func (h *Host) CurrentTarget() (string, error) {
	info, err := os.Lstat(runnerSymlink)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return filepath.EvalSymlinks(runnerSymlink)
	}

	legacy := filepath.Join(releasesDir, "legacy-"+time.Now().UTC().Format("20060102150405"))
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(legacy, "boxlite-runner")
	if err := copyFile(runnerSymlink, target, 0o755); err != nil {
		return "", err
	}
	sum, err := fileSHA256(target)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(target+".sha256", []byte(sum+"\n"), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

func (h *Host) Activate(target string) error {
	tmp := runnerSymlink + ".tmp"
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	// Rename over the old symlink so the live path is never briefly absent.
	return os.Rename(tmp, runnerSymlink)
}

func (h *Host) PruneReleases(keep int) error {
	if keep <= 0 {
		return nil
	}
	entries, err := os.ReadDir(releasesDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}

	live, _ := filepath.EvalSymlinks(runnerSymlink)
	type release struct {
		path    string
		modTime time.Time
	}
	var releases []release
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		releases = append(releases, release{filepath.Join(releasesDir, entry.Name()), info.ModTime()})
	}
	sort.Slice(releases, func(i, j int) bool { return releases[i].modTime.After(releases[j].modTime) })

	for i, r := range releases {
		if i < keep {
			continue
		}
		// Never prune the directory the live symlink points into, however old.
		if live != "" && strings.HasPrefix(live, r.path+string(filepath.Separator)) {
			continue
		}
		if err := os.RemoveAll(r.path); err != nil {
			return err
		}
	}
	return nil
}

// ── runtime cache ────────────────────────────────────────────────────────────

// RuntimeCacheDirName is the directory the runner extracts its embedded runtime
// into. A dev build gets its own suffix so it can never reuse — or poison — the
// official v{VERSION} cache of a release with the same base version.
func RuntimeCacheDirName(version, suffix string) string {
	base := version
	if idx := strings.Index(base, "-dev-"); idx >= 0 {
		base = base[:idx]
	}
	if suffix == "" {
		return "v" + base
	}
	return "v" + base + "-" + suffix
}

func (h *Host) serviceUserHome() string {
	out, err := exec.Command("systemctl", "show", h.service, "--property=User", "--value").Output()
	name := strings.TrimSpace(string(out))
	if err != nil || name == "" {
		name = "root"
	}
	if u, err := user.Lookup(name); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	return "/root"
}

func (h *Host) PrimaryRuntimeCacheDir(dirName string) string {
	return filepath.Join(h.serviceUserHome(), ".local", "share", "boxlite", "runtimes", dirName)
}

// runtimeCacheDirs lists every place a runtime cache for dirName could exist.
// The runner picks its data directory from the environment it runs under, which
// is not necessarily the service user's home — so verification checks all of
// them rather than assuming the one we installed into is the one that will be
// read.
func (h *Host) runtimeCacheDirs(dirName string) []string {
	roots := []string{filepath.Join(h.serviceUserHome(), ".local", "share")}

	if out, err := exec.Command("systemctl", "show", h.service, "--property=Environment", "--value").Output(); err == nil {
		for _, kv := range strings.Fields(string(out)) {
			key, value, ok := strings.Cut(kv, "=")
			if !ok || value == "" {
				continue
			}
			switch key {
			case "XDG_DATA_HOME":
				roots = append(roots, value)
			case "HOME":
				roots = append(roots, filepath.Join(value, ".local", "share"))
			}
		}
	}

	roots = append(roots, "/root/.local/share")
	if homes, err := filepath.Glob("/home/*"); err == nil {
		for _, home := range homes {
			roots = append(roots, filepath.Join(home, ".local", "share"))
		}
	}

	seen := map[string]bool{}
	var dirs []string
	for _, root := range roots {
		dir := filepath.Join(root, "boxlite", "runtimes", dirName)
		if seen[dir] {
			continue
		}
		seen[dir] = true
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// InstallRuntimePayload extracts the payload into the cache directory for this
// build, refusing to publish it unless the guest binary inside hashes to what
// the artifact says it should.
func (h *Host) InstallRuntimePayload(payload, guestSHA256, dirName string) (string, error) {
	cacheDir := h.PrimaryRuntimeCacheDir(dirName)
	staging := cacheDir + ".tmp"
	if err := os.RemoveAll(staging); err != nil {
		return "", err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return "", err
	}

	if err := extractTarGz(payload, staging); err != nil {
		os.RemoveAll(staging)
		return "", fmt.Errorf("unpack runtime payload: %w", err)
	}

	guestPath := filepath.Join(staging, "boxlite-guest")
	actual, err := fileSHA256(guestPath)
	if err != nil {
		os.RemoveAll(staging)
		return "", fmt.Errorf("runtime payload has no readable boxlite-guest: %w", err)
	}
	if actual != guestSHA256 {
		os.RemoveAll(staging)
		return "", fmt.Errorf("runtime payload guest hash mismatch: want %s got %s", guestSHA256, actual)
	}

	if err := os.MkdirAll(filepath.Dir(cacheDir), 0o755); err != nil {
		os.RemoveAll(staging)
		return "", err
	}
	if err := os.RemoveAll(cacheDir); err != nil {
		os.RemoveAll(staging)
		return "", err
	}
	if err := os.Rename(staging, cacheDir); err != nil {
		os.RemoveAll(staging)
		return "", err
	}
	return cacheDir, nil
}

// VerifyRuntimeGuestHash is the gate that keeps a running runner from serving
// box creates against a stale guest binary. Finding no cache at all is a
// failure, not a pass: it means the runner would fall back to extracting
// whatever it has embedded, which is the situation this check exists to catch.
func (h *Host) VerifyRuntimeGuestHash(guestSHA256, dirName string) error {
	dirs := h.runtimeCacheDirs(dirName)
	checked := 0
	for _, dir := range dirs {
		guestPath := filepath.Join(dir, "boxlite-guest")
		if _, err := os.Stat(guestPath); err != nil {
			continue
		}
		checked++
		actual, err := fileSHA256(guestPath)
		if err != nil {
			return err
		}
		if actual != guestSHA256 {
			return fmt.Errorf("runtime guest hash mismatch in %s: want %s got %s", dir, guestSHA256, actual)
		}
	}
	if checked == 0 {
		return fmt.Errorf("no runtime cache found for %s; refusing to leave the runner able to start a box on an unverified guest", dirName)
	}
	return nil
}

// WriteRuntimeDirDropIn pins BOXLITE_RUNTIME_DIR for the unit. Without it a
// dev build's suffixed cache directory would be invisible to the runner, which
// would then extract its embedded runtime into the unsuffixed release path.
func (h *Host) WriteRuntimeDirDropIn(cacheDir string) error {
	if info, err := os.Stat(cacheDir); err != nil || !info.IsDir() {
		return fmt.Errorf("runtime cache directory missing before start: %s", cacheDir)
	}
	path := fmt.Sprintf(dropInPath, h.service)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	content := fmt.Sprintf("[Service]\nEnvironment=BOXLITE_RUNTIME_DIR=%s\n", cacheDir)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return err
	}
	return h.daemonReload()
}

// ── systemd + health ─────────────────────────────────────────────────────────

func (h *Host) daemonReload() error {
	return exec.Command("systemctl", "daemon-reload").Run()
}

func (h *Host) Stop() error {
	// A unit that is already dead is a fine starting point for an install.
	_ = exec.Command("systemctl", "stop", h.service).Run()
	return nil
}

func (h *Host) Start() error {
	if err := exec.Command("systemctl", "start", h.service).Run(); err != nil {
		return fmt.Errorf("start %s: %w", h.service, err)
	}
	return nil
}

func (h *Host) IsActive() bool {
	return exec.Command("systemctl", "is-active", "--quiet", h.service).Run() == nil
}

// WaitReady polls the runner's root endpoint until it serves.
func (h *Host) WaitReady(ctx context.Context) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := h.get(ctx, "/", false); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("runner API did not become ready at %s", h.baseURL())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// VerifyHealth samples /info twice a couple of seconds apart. One successful
// response only proves the process bound its port; a second proves it did not
// fall over immediately after.
func (h *Host) VerifyHealth(ctx context.Context) error {
	for i := 1; i <= 2; i++ {
		if _, err := h.get(ctx, "/info", true); err != nil {
			return fmt.Errorf("runner health sample %d: %w", i, err)
		}
		if i == 1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
	}
	return nil
}

func (h *Host) get(ctx context.Context, path string, authenticated bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.baseURL()+path, nil)
	if err != nil {
		return nil, err
	}
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+h.env.token)
	}
	res, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("GET %s: HTTP %d", path, res.StatusCode)
	}
	return body, nil
}

func (h *Host) JournalTail(lines int) string {
	out, err := exec.Command("journalctl", "-u", h.service, "--no-pager", "-n", strconv.Itoa(lines)).CombinedOutput()
	if err != nil {
		return ""
	}
	return string(out)
}

func copyFile(src, dest string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
