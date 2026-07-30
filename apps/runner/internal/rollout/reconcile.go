// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package rollout

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// defaultKeepReleases bounds /usr/local/lib/boxlite-runner/releases. Deep
// enough that the build before last is always available to roll back to.
const defaultKeepReleases = 5

// Reconciler brings this box to the build named by the desired state, whether
// that means a first install at boot or replacing a running runner.
//
// Both paths are this one function on purpose: when boot and rollout were
// separate implementations they drifted, and a replaced instance came up
// without the versioned release directory, the guest-hash check, or the
// BOXLITE_RUNTIME_DIR drop-in that a rolled-out instance had.
type Reconciler struct {
	source       *ParameterSource
	fetcher      *Fetcher
	host         *Host
	log          *slog.Logger
	keepReleases int
}

func NewReconciler(source *ParameterSource, fetcher *Fetcher, host *Host, log *slog.Logger) *Reconciler {
	return &Reconciler{
		source:       source,
		fetcher:      fetcher,
		host:         host,
		log:          log,
		keepReleases: defaultKeepReleases,
	}
}

// swapTarget is one candidate for the live binary — the incoming build, or the
// one being rolled back to.
type swapTarget struct {
	binary string
	// cacheDir empty leaves the existing BOXLITE_RUNTIME_DIR drop-in alone,
	// which is what a rollback to a pre-agent install has to do.
	cacheDir string
	// guestSHA256 empty skips guest verification. Only legitimate when rolling
	// back to a build whose payload hash was never recorded.
	guestSHA256    string
	runtimeDirName string
}

func (r *Reconciler) Reconcile(ctx context.Context) error {
	desired, err := r.source.Get(ctx)
	if err != nil {
		return err
	}
	installed := readInstalled(r.log)

	if installed.matches(desired) && r.host.IsActive() {
		dirName := RuntimeCacheDirName(installed.Version, installed.RuntimeSuffix)
		if err := r.host.VerifyRuntimeGuestHash(installed.GuestSHA256, dirName); err == nil {
			r.log.Info("already at desired build", "version", desired.Version)
			return nil
		} else {
			// The binary is right but its runtime is not — reinstall rather
			// than leave a runner that would start boxes on the wrong guest.
			r.log.Warn("installed build matches but its runtime cache failed verification; reinstalling",
				"version", installed.Version, "error", err)
		}
	}

	r.log.Info("reconciling runner build",
		"from", orNone(installed.Version), "to", desired.Version, "url", desired.URL)

	workDir, err := os.MkdirTemp("", "boxlite-runner-rollout-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workDir)

	artifact, err := r.fetcher.Fetch(ctx, desired, workDir)
	if err != nil {
		return err
	}
	r.log.Info("artifact verified",
		"version", artifact.Version, "guest", short(artifact.GuestSHA256), "runtimeSuffix", orNone(artifact.RuntimeSuffix))

	dirName := RuntimeCacheDirName(artifact.Version, artifact.RuntimeSuffix)
	cacheDir, err := r.host.InstallRuntimePayload(artifact.RuntimePayload, artifact.GuestSHA256, dirName)
	if err != nil {
		return err
	}
	r.log.Info("runtime payload installed", "dir", cacheDir, "guest", short(artifact.GuestSHA256))

	// Everything above is preparation and can fail without touching the running
	// runner. From the swap onwards a failure has to be undone, not just
	// reported — so both install targets are verified before the unit stops.
	newBinary, err := r.host.InstallRelease(artifact.Version, artifact.BinaryPath)
	if err != nil {
		return err
	}
	if err := r.host.VerifyRelease(newBinary, "new"); err != nil {
		return err
	}
	rollbackBinary, err := r.host.CurrentTarget()
	if err != nil {
		return err
	}
	if rollbackBinary != "" {
		if err := r.host.VerifyRelease(rollbackBinary, "rollback"); err != nil {
			return err
		}
	}
	r.log.Info("install targets ready", "new", newBinary, "rollback", orNone(rollbackBinary))

	shims, err := r.host.SnapshotDetachedShims()
	if err != nil {
		return err
	}
	r.log.Info("captured live detached shims", "count", len(shims))

	swapErr := r.swap(ctx, swapTarget{
		binary:         newBinary,
		cacheDir:       cacheDir,
		guestSHA256:    artifact.GuestSHA256,
		runtimeDirName: dirName,
	}, shims)
	if swapErr == nil {
		writeInstalled(r.log, InstalledState{
			Version:       artifact.Version,
			SHA256:        artifact.SHA256,
			GuestSHA256:   artifact.GuestSHA256,
			RuntimeSuffix: artifact.RuntimeSuffix,
			ReleaseDir:    filepath.Dir(newBinary),
		})
		if err := r.host.PruneReleases(r.keepReleases); err != nil {
			r.log.Warn("could not prune old releases", "error", err)
		}
		r.log.Info("runner is on the desired build", "version", artifact.Version)
		return nil
	}

	r.log.Error("rollout failed; rolling back", "error", swapErr)
	if rollbackBinary == "" {
		r.log.Error("no previous build to roll back to; runner left stopped")
		r.logJournal()
		return swapErr
	}

	previous := swapTarget{binary: rollbackBinary}
	if installed.Version != "" {
		previous.runtimeDirName = RuntimeCacheDirName(installed.Version, installed.RuntimeSuffix)
		previous.cacheDir = r.host.PrimaryRuntimeCacheDir(previous.runtimeDirName)
		previous.guestSHA256 = installed.GuestSHA256
	}
	if err := r.swap(ctx, previous, shims); err != nil {
		r.logJournal()
		return errors.Join(swapErr, fmt.Errorf("rollback also failed: %w", err))
	}

	r.log.Info("rollback complete", "version", orNone(installed.Version))
	r.logJournal()
	return swapErr
}

// swap stops the runner, points it at target, and refuses to call the result a
// success until the new process is serving and every box that was running
// before is still running and reachable.
func (r *Reconciler) swap(ctx context.Context, target swapTarget, shims []detachedShim) error {
	if err := r.host.Stop(); err != nil {
		return err
	}
	if err := r.host.Activate(target.binary); err != nil {
		return err
	}
	if target.cacheDir != "" {
		if err := r.host.WriteRuntimeDirDropIn(target.cacheDir); err != nil {
			return err
		}
	}
	if err := r.host.Start(); err != nil {
		return err
	}
	if !r.host.IsActive() {
		return fmt.Errorf("%s is not active after start", r.host.service)
	}
	if err := r.host.WaitReady(ctx); err != nil {
		return err
	}
	if err := r.host.VerifyHealth(ctx); err != nil {
		return err
	}
	if target.guestSHA256 != "" {
		if err := r.host.VerifyRuntimeGuestHash(target.guestSHA256, target.runtimeDirName); err != nil {
			return err
		}
	}
	if err := r.host.VerifyAdoptedShims(ctx, shims); err != nil {
		return err
	}
	if len(shims) > 0 {
		r.log.Info("re-adopted detached boxes", "count", len(shims))
	}
	return nil
}

func (r *Reconciler) logJournal() {
	if tail := r.host.JournalTail(50); tail != "" {
		r.log.Error("recent runner journal", "tail", tail)
	}
}

func readInstalled(log *slog.Logger) InstalledState {
	raw, err := os.ReadFile(installedFile)
	if err != nil {
		// Absent on a first boot and on any box installed before the agent
		// existed. Both mean "reconcile from scratch", not an error.
		return InstalledState{}
	}
	var state InstalledState
	if err := json.Unmarshal(raw, &state); err != nil {
		log.Warn("ignoring unreadable installed-state file", "path", installedFile, "error", err)
		return InstalledState{}
	}
	return state
}

func writeInstalled(log *slog.Logger, state InstalledState) {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		log.Warn("could not encode installed state", "error", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(installedFile), 0o755); err != nil {
		log.Warn("could not create installed-state directory", "error", err)
		return
	}
	// Written last, after the runner is verified healthy: if the process dies
	// mid-rollout, the next reconcile must not believe the new build landed.
	if err := os.WriteFile(installedFile, append(raw, '\n'), 0o644); err != nil {
		log.Warn("could not record installed state", "path", installedFile, "error", err)
	}
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func short(sha string) string {
	if len(sha) <= 12 {
		return sha
	}
	return sha[:12]
}
