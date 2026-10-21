//go:build linux

package privilege

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/envfilter"
)

// Supported reports whether the privilege split is implemented here.
func Supported() bool { return true }

func (c Config) marshal() ([]byte, error) { return json.MarshalIndent(c, "", "  ") }

// IsLauncher reports whether argv0 names the launcher.
func IsLauncher(argv0 string) bool { return filepath.Base(argv0) == filepath.Base(LauncherPath) }

// AppIdentity returns boxlite's uid, gid and group names. ok is false when the
// user does not exist (not a BoxLite image) or its ids do not parse: a
// failed parse would otherwise read as uid 0 and run app code as root.
func AppIdentity() (uid, gid int, groups []string, ok bool) {
	u, err := user.Lookup(AppUser)
	if err != nil {
		return defaultUID, defaultGID, nil, false
	}
	uid, uerr := strconv.Atoi(u.Uid)
	gid, gerr := strconv.Atoi(u.Gid)
	if uerr != nil || gerr != nil {
		return defaultUID, defaultGID, nil, false
	}
	if ids, err := u.GroupIds(); err == nil {
		for _, id := range ids {
			if g, err := user.LookupGroupId(id); err == nil {
				groups = append(groups, g.Name)
			}
		}
	}
	return uid, gid, groups, true
}

func lookPath(name string) string {
	for _, d := range strings.Split(safePath, ":") {
		p := filepath.Join(d, name)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// ---- step 0: become root ---------------------------------------------------

// Elevate re-execs the supervisor as root when it was started as the app user
// (a Box created with the protocol-1 `cmd`, or a run outside sudo). After the
// lockdown the only way up is the launcher; before it, boxlite still has the
// image's full sudo and the binary re-runs itself with `sudo -E`. It returns
// only on failure, and the caller then keeps running unprivileged.
func Elevate(boxPath string) error {
	sudo := lookPath("sudo")
	if sudo == "" {
		return errors.New("sudo is not installed")
	}
	quiet := func(args ...string) bool {
		c := exec.Command(sudo, args...)
		c.Stdin, c.Stdout, c.Stderr = nil, io.Discard, io.Discard
		return c.Run() == nil
	}
	if fi, err := os.Stat(LauncherPath); err == nil && fi.Mode()&0o111 != 0 && quiet("-n", "-l", LauncherPath) {
		return syscall.Exec(sudo, []string{"sudo", "-n", LauncherPath}, os.Environ())
	}
	if quiet("-n", "true") {
		self, err := os.Executable()
		if err != nil {
			return err
		}
		if boxPath == "" {
			boxPath = os.Getenv("PATH")
		}
		return syscall.Exec(sudo, []string{"sudo", "-n", "-E", self, "-box-path", boxPath}, os.Environ())
	}
	return errors.New("sudo allows neither the launcher nor a first-boot elevation")
}

// ---- the root-only directory -------------------------------------------------

func ownedByRoot(fi fs.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0
}

// ensureRootDir makes RootDir a real directory, root-owned, 0700. Anything
// else at that path (a symlink, a directory the app user made) is moved
// aside, never trusted.
func ensureRootDir() error {
	fi, err := os.Lstat(RootDir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return err
	case fi.IsDir() && fi.Mode()&fs.ModeSymlink == 0 && ownedByRoot(fi):
		return os.Chmod(RootDir, 0o700)
	default:
		aside := fmt.Sprintf("%s.untrusted-%d", RootDir, time.Now().UnixNano())
		if err := os.Rename(RootDir, aside); err != nil {
			if err := os.RemoveAll(RootDir); err != nil {
				return fmt.Errorf("cannot move untrusted %s aside: %w", RootDir, err)
			}
		}
	}
	if err := os.Mkdir(RootDir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	if err := os.Chown(RootDir, 0, 0); err != nil {
		return err
	}
	return os.Chmod(RootDir, 0o700)
}

// openRootDir opens RootDir and checks the opened directory itself (not the
// path, which the app user could swap) is root-owned 0700.
func openRootDir() (*os.Root, error) {
	if fi, err := os.Lstat(RootDir); err != nil || fi.Mode()&fs.ModeSymlink != 0 {
		return nil, fmt.Errorf("%s is missing or a symlink", RootDir)
	}
	r, err := os.OpenRoot(RootDir)
	if err != nil {
		return nil, err
	}
	fi, err := r.Stat(".")
	if err != nil || !fi.IsDir() || !ownedByRoot(fi) || fi.Mode().Perm() != 0o700 {
		r.Close()
		return nil, fmt.Errorf("%s is not a root-owned 0700 directory", RootDir)
	}
	return r, nil
}

var lockFile *os.File // held for the life of the process

func takeLock(root *os.Root) error {
	if v := os.Getenv(lockFDEnv); v != "" {
		os.Unsetenv(lockFDEnv)
		if fd, err := strconv.Atoi(v); err == nil {
			f := os.NewFile(uintptr(fd), "lock")
			if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil {
				syscall.CloseOnExec(int(f.Fd()))
				lockFile = f
				return nil
			}
			f.Close()
		}
	}
	f, err := root.OpenFile(lockName, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return ErrAlreadyRunning
		}
		return err
	}
	lockFile = f
	return nil
}

// ---- Bootstrap -----------------------------------------------------------------

// Bootstrap runs as root before anything else. It may not return: when the
// box token is still in the environment it re-execs the process without it.
func Bootstrap(boxPath string, logf Logf) (*Result, error) {
	uid, gid, groups, ok := AppIdentity()
	if !ok {
		return nil, fmt.Errorf("user %s does not exist", AppUser)
	}
	if err := ensureRootDir(); err != nil {
		return nil, fmt.Errorf("root dir: %w", err)
	}
	root, err := openRootDir()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := takeLock(root); err != nil {
		return nil, err
	}

	// 1. Config: from the environment on a first-boot start (sudo -E from the
	// Box cmd, before any app code ran), otherwise from the root-only file.
	var cfg Config
	fromEnv := os.Getenv("BOXLITE_BOX_TOKEN") != "" && os.Getenv(launchedEnv) != "1"
	if fromEnv {
		cfg = Config{
			CPURL:     os.Getenv("BOXLITE_CP_URL"),
			Token:     os.Getenv("BOXLITE_BOX_TOKEN"),
			EnvID:     os.Getenv("BOXLITE_ENV_ID"),
			TrustUser: envfilter.On(os.Getenv("SV_TRUST_USER_HEADERS")),
			Insecure:  envfilter.On(os.Getenv("SV_CP_INSECURE")),
			BaseEnv:   envfilter.App(os.Environ(), boxPath),
		}
		if cfg.CPURL == "" || cfg.EnvID == "" {
			return nil, errors.New("BOXLITE_CP_URL and BOXLITE_ENV_ID are required")
		}
		data, err := cfg.marshal()
		if err != nil {
			return nil, err
		}
		if err := root.WriteFile(configName+".tmp", data, 0o600); err != nil {
			return nil, err
		}
		if err := root.Rename(configName+".tmp", configName); err != nil {
			return nil, err
		}
		// Defence in depth: the token must not stay in this process's
		// environ (/proc/<pid>/environ keeps the exec-time copy whatever
		// os.Unsetenv does). Re-exec with a clean environment, keeping the
		// lock across the exec so no second instance can slip in, and from
		// the root-owned cached copy: a protocol-1 Box started this process
		// from ~/.microcloud/sv, a path the app user controls.
		if err := installSelf(root); err != nil {
			return nil, fmt.Errorf("caching the supervisor binary: %w", err)
		}
		return nil, reexecClean(root)
	}
	data, err := root.ReadFile(configName)
	if err != nil {
		return nil, fmt.Errorf("no Box config in %s; the Box cmd must start the supervisor once with its environment: %w", RootDir, err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse the Box config: %w", err)
	}
	for _, k := range []string{"BOXLITE_BOX_TOKEN", "BOXLITE_CP_URL", "BOXLITE_ENV_ID", launchedEnv} {
		os.Unsetenv(k)
	}

	// 2. The binary: the cached copy the launcher execs, and the launcher.
	if err := installSelf(root); err != nil {
		logf("privilege: caching the supervisor binary failed: %v", err)
	}
	launcherOK := true
	if err := installLauncher(); err != nil {
		launcherOK = false
		logf("privilege: installing %s failed: %v; sudo is left as it is so the next start can still become root", LauncherPath, err)
	}

	// 3. The app dir must be a real directory owned by the app user: root
	// reads and writes there, and a symlink planted by app code on a previous
	// run must not redirect it.
	if err := prepareAppDir(uid, gid); err != nil {
		return nil, fmt.Errorf("app dir: %w", err)
	}

	// 4. sudo: only the launcher.
	locked := false
	if launcherOK {
		locked, err = lockdown(Principal{User: AppUser, UID: uid, Groups: groups}, logf)
		if err != nil {
			logf("privilege: sudo lockdown: %v", err)
		}
	}
	if locked {
		logf("privilege: %s may now run only %s as root", AppUser, LauncherPath)
	} else {
		logf("privilege: WARNING: %s still has sudo rights beyond the launcher", AppUser)
	}
	return &Result{Config: cfg, UID: uid, GID: gid, SudoLocked: locked}, nil
}

func reexecClean(root *os.Root) error {
	fd := lockFile.Fd()
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_SETFD, 0); errno != 0 {
		return errno
	}
	f, err := root.Open(binaryName)
	if err != nil {
		return err
	}
	env := []string{"PATH=" + safePath, launchedEnv + "=1", lockFDEnv + "=" + strconv.Itoa(int(fd))}
	return syscall.Exec(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), []string{"microcloud-supervisor"}, env)
}

func fileSHA(r io.Reader) ([]byte, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// installSelf copies the running image (read through /proc/self/exe, so a
// swapped file at the original path does not matter) to RootDir/sv.
func installSelf(root *os.Root) error {
	self, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		return err
	}
	if f, err := root.Open(binaryName); err == nil {
		cur, _ := fileSHA(f)
		f.Close()
		want := sha256.Sum256(self)
		if bytes.Equal(cur, want[:]) {
			return root.Chmod(binaryName, 0o755)
		}
	}
	if err := root.WriteFile(binaryName+".self", self, 0o700); err != nil {
		return err
	}
	if err := root.Chmod(binaryName+".self", 0o755); err != nil {
		return err
	}
	return root.Rename(binaryName+".self", binaryName)
}

// installLauncher copies the running image to LauncherPath (root:root 0755).
// The launcher is this same program; IsLauncher picks the mode from argv0.
func installLauncher() error {
	dir := filepath.Dir(LauncherPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() || !ownedByRoot(fi) || fi.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s is not a root-owned directory closed to others", dir)
	}
	self, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		return err
	}
	if cur, err := os.ReadFile(LauncherPath); err == nil && bytes.Equal(cur, self) {
		if fi, err := os.Lstat(LauncherPath); err == nil && fi.Mode().IsRegular() && ownedByRoot(fi) && fi.Mode().Perm() == 0o755 {
			return nil
		}
	}
	tmp := filepath.Join(dir, ".microcloud-sv.tmp")
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, self, 0o700); err != nil {
		return err
	}
	if err := os.Chown(tmp, 0, 0); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, LauncherPath)
}

func prepareAppDir(uid, gid int) error {
	fi, err := os.Lstat(AppDir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return err
	case fi.Mode()&fs.ModeSymlink != 0:
		if err := os.Remove(AppDir); err != nil {
			return err
		}
	case !fi.IsDir():
		if err := os.Rename(AppDir, fmt.Sprintf("%s.moved-%d", AppDir, time.Now().UnixNano())); err != nil {
			return err
		}
	}
	if err := os.Mkdir(AppDir, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return os.Lchown(AppDir, uid, gid)
}

// ---- sudo lockdown ---------------------------------------------------------------

func sudoersFiles() []string {
	files := []string{"/etc/sudoers"}
	entries, _ := os.ReadDir("/etc/sudoers.d")
	for _, e := range entries {
		name := e.Name()
		// sudo itself skips names containing '.' or ending in '~'.
		if strings.Contains(name, ".") || strings.HasSuffix(name, "~") || filepath.Join("/etc/sudoers.d", name) == SudoersFile {
			continue
		}
		if e.Type().IsRegular() {
			files = append(files, filepath.Join("/etc/sudoers.d", name))
		}
	}
	return files
}

func writeRootFile(path string, data []byte, mode os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".microcloud.tmp")
	_ = os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Chown(tmp, 0, 0); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// lockdown leaves the app user exactly one sudo right: the launcher, no
// arguments. It validates every edit with visudo, restores the originals if
// the result does not parse, and checks the outcome with `sudo -l -U`.
func lockdown(p Principal, logf Logf) (bool, error) {
	sudo, visudo := lookPath("sudo"), lookPath("visudo")
	if sudo == "" {
		return true, nil // no sudo at all: nothing to lock (and nothing to escalate with)
	}
	if visudo == "" {
		return false, errors.New("visudo not found; refusing to edit sudoers blind")
	}
	if err := os.MkdirAll("/etc/sudoers.d", 0o750); err != nil {
		return false, err
	}

	// Our rule first, so there is never a moment without a way up.
	installed := false
	for _, withDefaults := range []bool{true, false} {
		tmp := "/etc/sudoers.d/.microcloud.check"
		if err := os.WriteFile(tmp, []byte(sudoersRule(p.User, LauncherPath, withDefaults)), 0o440); err != nil {
			return false, err
		}
		out, err := exec.Command(visudo, "-c", "-q", "-f", tmp).CombinedOutput()
		os.Remove(tmp)
		if err != nil {
			logf("privilege: visudo rejected the launcher rule (defaults=%v): %s", withDefaults, strings.TrimSpace(string(out)))
			continue
		}
		if err := writeRootFile(SudoersFile, []byte(sudoersRule(p.User, LauncherPath, withDefaults)), 0o440); err != nil {
			return false, err
		}
		installed = true
		break
	}
	if !installed {
		return false, errors.New("could not install the launcher rule")
	}

	// Everything else that grants the user anything is commented out.
	files := sudoersFiles()
	contents := map[string][]byte{}
	var all []string
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		contents[f] = b
		all = append(all, string(b))
	}
	aliases := UserAliases(all...)
	var changed []string
	modes := map[string]os.FileMode{}
	for _, f := range files {
		b, ok := contents[f]
		if !ok {
			continue
		}
		next, did := Neutralise(string(b), p, aliases)
		if !did {
			continue
		}
		mode := os.FileMode(0o440)
		if fi, err := os.Stat(f); err == nil {
			mode = fi.Mode().Perm()
		}
		modes[f] = mode
		if err := writeRootFile(f, []byte(next), mode); err != nil {
			return false, fmt.Errorf("rewrite %s: %w", f, err)
		}
		changed = append(changed, f)
	}
	if out, err := exec.Command(visudo, "-c", "-q").CombinedOutput(); err != nil {
		var failed []error
		for _, f := range changed {
			if rerr := writeRootFile(f, contents[f], modes[f]); rerr != nil {
				failed = append(failed, fmt.Errorf("restore %s: %w", f, rerr))
			}
		}
		if len(failed) > 0 {
			return false, fmt.Errorf("sudoers no longer parses after the edit (%s) and restoring the originals failed: %w", strings.TrimSpace(string(out)), errors.Join(failed...))
		}
		return false, fmt.Errorf("sudoers no longer parses after the edit, restored (%s)", strings.TrimSpace(string(out)))
	}
	if len(changed) > 0 {
		logf("privilege: disabled sudo rules for %s in %s", p.User, strings.Join(changed, ", "))
	}
	return verifyLocked(sudo, p.User)
}

// verifyLocked asks sudo itself what the user may run.
func verifyLocked(sudo, user string) (bool, error) {
	out, _ := exec.Command(sudo, "-n", "-l", "-U", user).CombinedOutput()
	if !OnlyLauncher(string(out), LauncherPath) {
		return false, fmt.Errorf("`sudo -l -U %s` still lists more than the launcher:\n%s", user, strings.TrimSpace(string(out)))
	}
	// Belt and braces: a shell must be refused, the launcher allowed.
	if exec.Command(sudo, "-n", "-l", "-U", user, "/bin/sh").Run() == nil {
		return false, fmt.Errorf("`sudo -l -U %s /bin/sh` is still allowed", user)
	}
	if exec.Command(sudo, "-n", "-l", "-U", user, LauncherPath).Run() != nil {
		return false, fmt.Errorf("`sudo -l -U %s %s` is refused; the next start could not become root", user, LauncherPath)
	}
	return true, nil
}

// ---- launcher -----------------------------------------------------------------------

// Launch is the launcher: run by `sudo -n /usr/local/sbin/microcloud-sv` from
// the Box cmd as the app user. sudo has reset the environment; the launcher
// drops what is left, reads the Box config from the root-only dir, fetches a
// newer supervisor as root (keeping the cached one when the control plane is
// unreachable), verifies the cached binary, and execs it. It returns only on
// failure.
func Launch(logf Logf) error {
	if os.Geteuid() != 0 {
		return errors.New("the launcher must run as root (sudo -n " + LauncherPath + ")")
	}
	os.Clearenv()
	os.Setenv("PATH", safePath)
	root, err := openRootDir()
	if err != nil {
		return err
	}
	data, err := root.ReadFile(configName)
	if err != nil {
		return fmt.Errorf("no Box config: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("parse the Box config: %w", err)
	}
	for attempt := 0; ; attempt++ {
		err := update(root, cfg)
		if err == nil {
			break
		}
		if _, statErr := root.Stat(binaryName); statErr == nil {
			logf("launcher: update failed (%v); starting the cached supervisor", err)
			break
		}
		if attempt%15 == 0 {
			logf("launcher: no cached supervisor and the download failed (%v); retrying every 2 s", err)
		}
		time.Sleep(2 * time.Second)
	}
	f, err := root.Open(binaryName)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() || !ownedByRoot(fi) || fi.Mode().Perm()&0o022 != 0 || fi.Mode().Perm()&0o100 == 0 {
		return fmt.Errorf("%s/%s is not a root-owned executable closed to others", RootDir, binaryName)
	}
	// Exec through the open descriptor: the file checked above is the file run,
	// whatever happens to the path in between.
	env := []string{"PATH=" + safePath, launchedEnv + "=1"}
	return syscall.Exec(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), []string{"microcloud-supervisor"}, env)
}

// update downloads supervisor-linux-<arch> into RootDir/sv when it differs
// from the cached copy and passes a sanity check (an ELF that runs and
// prints its version), so a truncated or wrong-arch download never replaces
// a working binary.
func update(root *os.Root, cfg Config) error {
	if cfg.CPURL == "" {
		return errors.New("no control plane URL in the Box config")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if cfg.Insecure {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // local tests only
	}
	client := &http.Client{Transport: tr, Timeout: 20 * time.Second}
	url := strings.TrimRight(cfg.CPURL, "/") + "/sv/bin/supervisor-linux-" + runtime.GOARCH
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	const tmp = binaryName + ".new"
	_ = root.Remove(tmp)
	w, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, 256<<20))
	if cerr := w.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		root.Remove(tmp)
		return err
	}
	if f, err := root.Open(binaryName); err == nil {
		cur, _ := fileSHA(f)
		f.Close()
		if bytes.Equal(cur, h.Sum(nil)) {
			root.Remove(tmp)
			return nil
		}
	}
	if ReleasePublicKey != "" {
		if err := verifyDownload(client, url, h.Sum(nil)); err != nil {
			root.Remove(tmp)
			return err
		}
	}
	if err := checkBinary(root, tmp, n); err != nil {
		root.Remove(tmp)
		return err
	}
	if err := root.Chmod(tmp, 0o755); err != nil {
		return err
	}
	return root.Rename(tmp, binaryName)
}

// verifyDownload fetches <url>.sig and checks it against the downloaded binary's digest.
func verifyDownload(client *http.Client, url string, digest []byte) error {
	resp, err := client.Get(url + ".sig")
	if err != nil {
		return fmt.Errorf("fetch signature: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s.sig: HTTP %d: %w", url, resp.StatusCode, ErrBadSignature)
	}
	sig, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return fmt.Errorf("read signature: %w", err)
	}
	return VerifyRelease(ReleasePublicKey, digest, string(sig))
}

func checkBinary(root *os.Root, name string, size int64) error {
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(f, magic); err != nil || !bytes.Equal(magic, []byte("\x7fELF")) || size < 1<<20 {
		return fmt.Errorf("download is not a supervisor binary (%d bytes)", size)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, fmt.Sprintf("/proc/self/fd/%d", f.Fd()), "-version")
	cmd.Env = []string{"PATH=" + safePath}
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("downloaded binary does not run: %w", err)
	}
	if !strings.HasPrefix(string(out), "supervisor ") {
		return fmt.Errorf("downloaded binary is not a supervisor: -version printed %q", strings.TrimSpace(string(out)))
	}
	return nil
}

// sudoersRule is the whole of boxlite's sudo rights after the lockdown: one
// program, as root, with no arguments (`""`), with the environment reset.
// pam_session/pam_setcred/use_pty off let sudo exec the launcher directly, so
// on later boots the supervisor is PID 1 again instead of a child of sudo.
func sudoersRule(user, launcher string, withDefaults bool) string {
	var b strings.Builder
	b.WriteString("# Managed by the BoxLite Micro-cloud supervisor (contracts.md 2.1).\n")
	b.WriteString("# " + user + " may run exactly one program as root: the supervisor launcher, without arguments.\n")
	b.WriteString("# Every other sudo right of " + user + " was disabled at boot. Do not edit.\n")
	if withDefaults {
		b.WriteString("Defaults:" + user + " env_reset, !setenv, !use_pty, !log_output, !log_input, !pam_session, !pam_setcred\n")
	} else {
		b.WriteString("Defaults:" + user + " env_reset, !setenv\n")
	}
	b.WriteString(user + " ALL=(root) NOPASSWD: " + launcher + " \"\"\n")
	return b.String()
}
