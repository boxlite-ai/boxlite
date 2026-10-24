// Package privilege splits the Box into a root supervisor and an unprivileged
// app (contracts.md 2.1, security review F2).
//
// The Box image runs `cmd` as the app user, boxlite, who starts out with
// passwordless sudo for everything. The supervisor uses that once:
//
//  1. First boot: `cmd` runs `sudo -E` on a root shell that downloads the
//     supervisor into the root-only dir and execs it. (A Box created with the
//     protocol-1 `cmd` execs the binary as boxlite instead; it then elevates
//     itself, see Elevate.)
//  2. As root, Bootstrap persists the Box config into the root-only dir,
//     installs a root-owned launcher at LauncherPath, replaces every sudo
//     right of boxlite with one rule allowing exactly that launcher, verifies
//     the result with `sudo -l -U boxlite`, and re-execs itself without the box
//     token in its environment.
//  3. Every later start: `cmd` finds the launcher and runs `sudo -n` on it.
//     The launcher (Launch) ignores its environment, downloads a newer
//     supervisor as root (keeping the cached one when the control plane is
//     unreachable), checks the cached binary is root-owned inside the
//     root-only dir, and execs it.
//
// Services and build steps then run as boxlite with no sudo, so app code can
// read neither the state (secrets, resolved env) nor the supervisor's
// environment.
package privilege

import (
	"errors"

	"github.com/boxlite-ai/microcloud/supervisor/internal/envfilter"
)

// Fixed locations. They are not configurable from the environment on purpose:
// in launcher mode the environment comes from a process the app controls.
const (
	AppUser      = "boxlite"
	AppHome      = "/home/boxlite"
	RootDir      = "/home/boxlite/.microcloud-root" // 0700 root: binary, config, state, lock
	AppDir       = "/home/boxlite/app"              // boxlite: releases/, current
	LauncherPath = "/usr/local/sbin/microcloud-sv"
	SudoersFile  = "/etc/sudoers.d/microcloud" // no dot: sudo skips names containing '.'
	binaryName   = "sv"
	configName   = "config.json"
	lockName     = "lock"
	launchedEnv  = "SV_LAUNCHED"
	lockFDEnv    = "SV_LOCK_FD"
	safePath     = envfilter.DefaultPath
)

// Default app identity when /etc/passwd has no entry (the measured values).
const (
	defaultUID = 1001
	defaultGID = 1001
)

// Config is what the supervisor needs from the Box environment, persisted at
// first boot so that later starts through the launcher (whose environment sudo
// has reset) do not depend on anything the app user can set.
type Config struct {
	CPURL     string   `json:"cp_url"`
	Token     string   `json:"box_token"`
	EnvID     string   `json:"env_id"`
	TrustUser bool     `json:"trust_user_headers"`
	Insecure  bool     `json:"cp_insecure"`
	BaseEnv   []string `json:"base_env"` // the Box env minus platform secrets, for services
}

// ErrAlreadyRunning means another root supervisor holds the lock. boxlite may
// run the launcher at any time; a second instance must leave at once.
var ErrAlreadyRunning = errors.New("another supervisor is already running in this Box")

// Logf is how this package reports progress (the supervisor's log hub is not
// up yet when most of it runs).
type Logf func(format string, args ...any)

// Result is what Bootstrap hands to main.
type Result struct {
	Config     Config
	UID, GID   int
	SudoLocked bool
}
