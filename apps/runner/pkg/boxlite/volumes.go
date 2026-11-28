// Copyright 2025 Daytona Platforms Inc.
// Copyright 2025-2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/boxlite-ai/common-go/pkg/log"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

const volumeMountPrefix = "boxlite-volume-"
const filestoreMountPrefix = "boxlite-filestore-"
const volumeMountRecordDir = ".boxlite-volume-mounts"

var filestoreInstanceNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// How long a mount command may run before it is killed. The request context
// cannot serve as this bound: Create is handed an undeadlined gin request
// context, and gcsfuse retries an unreachable bucket forever, so without an
// explicit deadline a misconfigured backend wedges box creation indefinitely.
const volumeMountTimeout = 90 * time.Second

// Bound for the local mount probes and teardown. A wedged FUSE mount blocks
// stat and umount indefinitely, which is exactly the state these run in.
var volumeProbeTimeout = 10 * time.Second

// Bound for the readiness loop as a whole. It has to be a deadline rather than
// a retry count: each probe can now burn volumeProbeTimeout against a wedged
// mount, so counting attempts would multiply into minutes of holding the
// per-volume mutex.
const volumeReadyTimeout = 30 * time.Second

type volumeCleanupConfig struct {
	interval        time.Duration
	dryRun          bool
	exclusionPeriod time.Duration
}

type volumeMount struct {
	hostPath  string
	mountPath string
	subPath   string
	readOnly  bool
	rootPath  string
	// backend labels what mounts rootPath; "s3"/"gcs" for object storage, and
	// "filestore" for an NFS mount. Records keep the label for humans and for
	// debugging; the reclaimer keys off rootPath regardless of backend.
	backend string
	// filestore-only fields. dataDir is the box's own directory inside the NFS
	// export — the bind source for this volume and the thing that survives a
	// destroy (destroy unbinds, never deletes data).
	dataDir           string
	filestoreInstance string
}

// boxVolumeMountEntry is one volume of one box in the box's mount record.
// The reclaimer counts a mount root as referenced when ANY entry names it, so
// a box mixing an object-storage volume and a filestore volume (allowed) lands
// as two entries with different backends in one record.
type boxVolumeMountEntry struct {
	Backend           string `json:"backend"`
	RootPath          string `json:"rootPath"`
	FilestoreInstance string `json:"filestoreInstance,omitempty"`
	// DataDir is filestore-only: the box's own directory inside the NFS
	// export, kept for troubleshooting. The reclaimer counts rootPath, never
	// dataDir — destroy leaves the data behind by design.
	DataDir string `json:"dataDir,omitempty"`
}

type boxVolumeMountRecord struct {
	BoxID   string                `json:"boxId"`
	Entries []boxVolumeMountEntry `json:"entries"`

	// Paths is the legacy record shape ({boxId, paths}). Records still carry
	// it for one release cycle so a runner binary rolled back to the
	// pre-entries version keeps seeing the references (its reader ignores
	// entries and would otherwise count zero references and reclaim live
	// mounts). entries and paths hold the same deduped rootPath set; new
	// readers fold both shapes and the reclaimer's map dedups the overlap.
	// Remove the field and the double-write once rolling back to a
	// pre-entries binary is no longer possible.
	Paths []string `json:"paths,omitempty"`
}

// UnmarshalJSON folds the legacy bare-paths shape into entries, so every
// reader sees one shape. A record from before filestore has no backend field:
// those paths are object-storage mounts by definition (filestore did not
// exist), and the backend label is inert for reading anyway — the reclaimer
// keys off rootPath.
func (r *boxVolumeMountRecord) UnmarshalJSON(data []byte) error {
	type recordAlias struct {
		BoxID   string                `json:"boxId"`
		Paths   []string              `json:"paths"`
		Entries []boxVolumeMountEntry `json:"entries"`
	}
	var alias recordAlias
	if err := json.Unmarshal(data, &alias); err != nil {
		return err
	}

	r.BoxID = alias.BoxID
	for _, path := range alias.Paths {
		r.Entries = append(r.Entries, boxVolumeMountEntry{Backend: volumeBackendS3, RootPath: path})
	}
	r.Entries = append(r.Entries, alias.Entries...)
	return nil
}

// volumeMountBasePathOverride lets a test point every volume mount path —
// mount roots, data dirs, record files — at a temp dir. Empty in production,
// where the environment decides between /mnt and /tmp. Same test-replacement
// pattern as client.go's currentUser.
var volumeMountBasePathOverride string

func getVolumeMountBasePath() string {
	if volumeMountBasePathOverride != "" {
		return volumeMountBasePathOverride
	}
	if config.GetEnvironment() == "development" {
		return "/tmp"
	}
	return "/mnt"
}

func (c *Client) getVolumeMounts(ctx context.Context, boxID string, volumes []dto.VolumeDTO) ([]volumeMount, error) {
	volumeMounts := make([]volumeMount, 0, len(volumes))

	// Validate syntax for every volume before mounting any backend. A bad
	// trailing volume must not leave backend roots or records from earlier
	// volumes in the same Box request. Normalize first because one trailing
	// slash was accepted by the original join and must keep restarting.
	for i, volume := range volumes {
		volume.Subpath = normalizeLegacySubPath(volume.Subpath)
		volumes[i] = volume
		if err := validateVolumeDTOShape(volume); err != nil {
			return nil, err
		}
	}

	fuseMountedVolumes := make(map[string]bool)
	// Per-call dedup remembers the verified target so two volumes on one
	// Filestore instance cannot silently select different shares.
	filestoreEnsured := make(map[string]string)

	for _, vol := range volumes {
		if vol.Filestore != nil {
			mount, err := c.filestoreVolumeMount(ctx, boxID, vol, filestoreEnsured)
			if err != nil {
				subpath := ""
				if vol.Subpath != nil {
					subpath = *vol.Subpath
				}
				attrs := []any{
					"code", "FILESTORE_VOLUME_PREPARE_FAILED",
					"boxId", boxID,
					"volumeId", vol.VolumeId,
					"backend", volumeBackendFilestore,
					"instance", vol.Filestore.Instance,
					"mountPath", vol.MountPath,
					"subpath", subpath,
					"readOnly", vol.ReadOnly,
					"error", err,
				}
				var exitError *exec.ExitError
				if errors.As(err, &exitError) {
					attrs = append(attrs, "exitCode", exitError.ExitCode())
				}
				c.logger.ErrorContext(ctx, "Failed to prepare Filestore volume", attrs...)
				return nil, fmt.Errorf(
					"FILESTORE_VOLUME_PREPARE_FAILED: failed to prepare filestore volume %s on instance %s for box %s: %w",
					vol.VolumeId, vol.Filestore.Instance, boxID, err,
				)
			}
			volumeMounts = append(volumeMounts, mount)
			continue
		}

		volumeIdPrefixed := fmt.Sprintf("%s%s", volumeMountPrefix, vol.VolumeId)
		baseMountPath := filepath.Join(getVolumeMountBasePath(), volumeIdPrefixed)

		subpathStr := ""
		if vol.Subpath != nil {
			subpathStr = *vol.Subpath
		}

		if !fuseMountedVolumes[volumeIdPrefixed] {
			err := c.ensureVolumeFuseMounted(ctx, volumeIdPrefixed, baseMountPath)
			if err != nil {
				return nil, err
			}
			fuseMountedVolumes[volumeIdPrefixed] = true
		}

		// The FUSE mountpoint (outside the backend volume) is ready now. lstat
		// rejects a symlink root or non-directory. Runner never joins subpath
		// into hostPath: read-write creation is guest-side and descriptor-based.
		if err := ensureCloudVolumeRoot(ctx, baseMountPath, "object storage volume root"); err != nil {
			c.logger.ErrorContext(
				ctx, "Failed to prepare object storage volume",
				"code", "VOLUME_ROOT_INVALID",
				"boxId", boxID,
				"volumeId", vol.VolumeId,
				"backend", c.volumeBackend,
				"mountPath", vol.MountPath,
				"subpath", subpathStr,
				"readOnly", vol.ReadOnly,
				"error", err,
			)
			return nil, err
		}

		c.logger.DebugContext(
			ctx, "planning volume mount",
			"volumeId", volumeIdPrefixed,
			"subpath", subpathStr,
			"readOnly", vol.ReadOnly,
			"mountPath", vol.MountPath,
		)
		volumeMounts = append(volumeMounts, volumeMount{
			hostPath:  baseMountPath,
			mountPath: vol.MountPath,
			subPath:   subpathStr,
			readOnly:  vol.ReadOnly,
			rootPath:  baseMountPath,
			backend:   c.volumeBackend,
		})
	}

	return volumeMounts, nil
}

// filestoreVolumeMount prepares one filestore volume reference for binding:
// under the instance's mutex it ensures the NFS mount exists (once per call),
// creates the volume's data directory and writes the referencing record. The data directory is named by the volume's
// id, not the box's: boxes sharing a volume share the directory (the
// bucket-alignment contract), and a destroyed box's data stays reachable by
// mounting the volume into a new box. `ensured` records the verified target
// for each instance prepared within this call.
//
// Holding the lock across the whole sequence is what makes the reclaim's
// in-lock record rescan sound: reclaim counts references from records under
// the same per-instance mutex, so a mount cannot be reclaimed in the window
// between "usable" and "referenced" (design §4.5).
func (c *Client) filestoreVolumeMount(ctx context.Context, boxID string, vol dto.VolumeDTO, ensured map[string]string) (volumeMount, error) {
	// The volume id names a data directory under the instance's mount root.
	// The control plane mints uuids, which cannot carry separators or '..',
	// but this boundary must not lean on that — the same posture as the box
	// id guard in client.go: a traversal-shaped or empty id is rejected
	// before any path is derived. An empty id is refused outright because
	// filestoreDataDir(root, "") would name the mount root itself, putting
	// every volume of the instance behind one box's bind mount.
	if vol.VolumeId == "" || vol.VolumeId == "." || strings.ContainsAny(vol.VolumeId, "/\\") || strings.Contains(vol.VolumeId, "..") {
		return volumeMount{}, fmt.Errorf(
			"invalid filestore volume id %q: must be a bare identifier without path separators or '..'",
			vol.VolumeId,
		)
	}
	ref := vol.Filestore
	if !filestoreInstanceNamePattern.MatchString(ref.Instance) {
		return volumeMount{}, fmt.Errorf("invalid filestore instance %q: must match %s", ref.Instance, filestoreInstanceNamePattern)
	}
	if err := validateFilestoreTarget(ref); err != nil {
		return volumeMount{}, err
	}
	subpath := ""
	if vol.Subpath != nil {
		subpath = *vol.Subpath
	}

	rootPath := filepath.Join(getVolumeMountBasePath(), filestoreMountPrefix+ref.Instance)

	mountKey := filestoreMountPrefix + ref.Instance
	mutex := c.volumeMutexFor(mountKey)
	mutex.Lock()
	defer mutex.Unlock()
	if err := c.checkVolumeOperation(mountKey); err != nil {
		return volumeMount{}, err
	}

	target := filestoreTarget(ref)
	if ensuredTarget, ok := ensured[ref.Instance]; ok {
		if ensuredTarget != target {
			return volumeMount{}, fmt.Errorf("conflicting filestore target for instance %s: request already verified %q, reference requests %q", ref.Instance, ensuredTarget, target)
		}
	} else {
		if err := c.ensureFilestoreMounted(ctx, ref, rootPath, mountKey); err != nil {
			return volumeMount{}, err
		}
		ensured[ref.Instance] = target
	}

	dataDir := filestoreDataDir(rootPath, vol.VolumeId)

	// This check happens before preparation writes. For read-only mounts it is
	// the zero-write gate: missing, symlinked, or non-directory roots fail
	// without MkdirAll or Chmod. A valid existing read-write root is reused.
	info, err := lstatBounded(ctx, dataDir)
	if err == nil {
		if !info.IsDir() {
			return volumeMount{}, fmt.Errorf(
				"VOLUME_SUBPATH_INVALID: filestore volume root %s is a symlink or not a directory",
				dataDir,
			)
		}
	} else if os.IsNotExist(err) {
		if vol.ReadOnly {
			return volumeMount{}, fmt.Errorf(
				"VOLUME_SUBPATH_NOT_FOUND: read-only filestore volume root %s does not exist",
				dataDir,
			)
		}
	} else {
		return volumeMount{}, fmt.Errorf(
			"VOLUME_SUBPATH_INVALID: cannot inspect filestore volume root %s: %w",
			dataDir, err,
		)
	}

	// NFS permissions are real (unlike the FUSE backends' --dir-mode
	// fakes), so the directory needs an explicit chmod after mkdir — plain
	// MkdirAll is masked by umask, and 0777 matches the posture the FUSE
	// backends reach for with --dir-mode 0777.
	prepare := c.prepareRunner
	if prepare == nil {
		prepare = func(dataDir string) error {
			if err := os.MkdirAll(dataDir, 0777); err != nil {
				return fmt.Errorf("failed to create filestore data directory %s: %s", dataDir, err)
			}
			// Chmod through a no-follow descriptor. A path-based Chmod would
			// follow a symlink swapped in after the Lstat above and could change
			// permissions outside the volume root.
			dir, err := os.OpenFile(dataDir, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return fmt.Errorf("failed to open filestore data directory %s: %s", dataDir, err)
			}
			defer dir.Close()
			info, err := dir.Stat()
			if err != nil {
				return fmt.Errorf("failed to stat filestore data directory %s: %s", dataDir, err)
			}
			if !info.IsDir() {
				return fmt.Errorf("VOLUME_ROOT_INVALID: filestore data directory %s is not a directory", dataDir)
			}
			if err := dir.Chmod(0777); err != nil {
				return fmt.Errorf("failed to chmod filestore data directory %s: %s", dataDir, err)
			}
			return nil
		}
	}
	prepareCtx, cancelPrepare := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancelPrepare()
	if _, err := c.runBoundedVolumeOperation(prepareCtx, mountKey, func() error {
		if vol.ReadOnly {
			// The lstat above already proved the root exists. Skip preparation
			// so an RO mount cannot chmod or otherwise mutate the volume root.
			return nil
		}
		return prepare(dataDir)
	}, func() {
		c.reclaimFilestoreMount(context.Background(), rootPath)
	}); err != nil {
		return volumeMount{}, err
	}

	mount := volumeMount{
		hostPath:          dataDir,
		mountPath:         vol.MountPath,
		subPath:           subpath,
		readOnly:          vol.ReadOnly,
		rootPath:          rootPath,
		backend:           volumeBackendFilestore,
		dataDir:           dataDir,
		filestoreInstance: ref.Instance,
	}

	// The referencing record is written inside the same critical section —
	// this is what design §4.5.2 pins: reclaim rescans records under this
	// instance's mutex, so the reference must become visible while the mount
	// is still protected. The entry is merged into the record instead of
	// replacing it: the record stays authoritative for a running box, and an
	// in-lock replacement would publish just the processed prefix — a
	// Start whose later volume failed would leave the record truncated while
	// the box kept every mount, handing the orphan reclaimer live references.
	if err := c.mergeBoxVolumeMountRecord(ctx, boxID, []volumeMount{mount}); err != nil {
		return volumeMount{}, err
	}

	return mount, nil
}

// preflightRecoveryVolumes checks deterministic mount failures before a
// recovery destroys the old Box. It may establish shared backend mounts, which
// live outside the mounted volume, but it never writes volume data or records.
func (c *Client) preflightRecoveryVolumes(ctx context.Context, volumes []dto.VolumeDTO) error {
	for i, vol := range volumes {
		vol.Subpath = normalizeLegacySubPath(vol.Subpath)
		volumes[i] = vol
		if err := validateVolumeDTOShape(vol); err != nil {
			return err
		}
		subpath := ""
		if vol.Subpath != nil {
			subpath = *vol.Subpath
		}
		if vol.Filestore == nil {
			volumeIdPrefixed := fmt.Sprintf("%s%s", volumeMountPrefix, vol.VolumeId)
			baseMountPath := filepath.Join(getVolumeMountBasePath(), volumeIdPrefixed)
			if err := c.ensureVolumeFuseMounted(ctx, volumeIdPrefixed, baseMountPath); err != nil {
				return err
			}
			if err := ensureCloudVolumeRoot(ctx, baseMountPath, "object storage volume root"); err != nil {
				return err
			}
			if err := preflightVolumeSubPath(ctx, baseMountPath, subpath, vol.ReadOnly); err != nil {
				return err
			}
			continue
		}

		ref := vol.Filestore
		rootPath := filepath.Join(getVolumeMountBasePath(), filestoreMountPrefix+ref.Instance)
		mountKey := filestoreMountPrefix + ref.Instance
		mutex := c.volumeMutexFor(mountKey)
		mutex.Lock()
		if err := c.checkVolumeOperation(mountKey); err != nil {
			mutex.Unlock()
			return err
		}
		err := c.ensureFilestoreMounted(ctx, ref, rootPath, mountKey)
		mutex.Unlock()
		if err != nil {
			return err
		}

		dataDir := filestoreDataDir(rootPath, vol.VolumeId)
		info, err := os.Lstat(dataDir)
		if err != nil {
			if os.IsNotExist(err) && !vol.ReadOnly {
				// RW preparation creates the data directory after Create.
				continue
			}
			if os.IsNotExist(err) {
				return fmt.Errorf("VOLUME_SUBPATH_NOT_FOUND: read-only filestore volume root %s does not exist", dataDir)
			}
			return fmt.Errorf("VOLUME_ROOT_INVALID: cannot inspect filestore volume root %s: %w", dataDir, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("VOLUME_ROOT_INVALID: filestore volume root %s is a symlink or not a directory", dataDir)
		}
		if err := preflightVolumeSubPath(ctx, dataDir, subpath, vol.ReadOnly); err != nil {
			return err
		}
	}
	return nil
}

func preflightVolumeSubPath(ctx context.Context, root, subPath string, readOnly bool) error {
	if subPath == "" {
		info, err := lstatBounded(ctx, root)
		if err != nil {
			if os.IsNotExist(err) && readOnly {
				return fmt.Errorf("VOLUME_SUBPATH_NOT_FOUND: volume root %s does not exist", root)
			}
			return fmt.Errorf("VOLUME_ROOT_INVALID: cannot inspect volume root %s: %w", root, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("VOLUME_ROOT_INVALID: volume root %s is a symlink or not a directory", root)
		}
		return nil
	}
	current := root
	for _, component := range strings.Split(subPath, "/") {
		current = filepath.Join(current, component)
		info, err := lstatBounded(ctx, current)
		if err != nil {
			if os.IsNotExist(err) && !readOnly {
				// RW may create the remainder after Create.
				return nil
			}
			if os.IsNotExist(err) {
				return fmt.Errorf("VOLUME_SUBPATH_NOT_FOUND: volume subpath %q does not exist", subPath)
			}
			return fmt.Errorf("VOLUME_SUBPATH_INVALID: cannot inspect volume subpath %q: %w", subPath, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("VOLUME_SUBPATH_INVALID: volume subpath %q contains a symlink or non-directory component", subPath)
		}
	}
	return nil
}

// validateVolumeDTOShape runs the side-effect-free checks for every backend
// before any FUSE/NFS mount or record write. Backend-specific mount checks still
// happen later, but malformed later entries can no longer leave earlier mounts.
func validateVolumeDTOShape(vol dto.VolumeDTO) error {
	subpath := ""
	if vol.Subpath != nil {
		subpath = *vol.Subpath
	}
	if err := validateCloudSubPath(subpath); err != nil {
		return err
	}
	if vol.VolumeId == "" || vol.VolumeId == "." || strings.ContainsAny(vol.VolumeId, "/\\") || strings.Contains(vol.VolumeId, "..") {
		return fmt.Errorf("invalid volume id %q: must be a bare identifier without path separators or '..'", vol.VolumeId)
	}
	if vol.Filestore == nil {
		return nil
	}
	if !filestoreInstanceNamePattern.MatchString(vol.Filestore.Instance) {
		return fmt.Errorf("invalid filestore instance %q: must match %s", vol.Filestore.Instance, filestoreInstanceNamePattern)
	}
	return validateFilestoreTarget(vol.Filestore)
}

func validateCloudSubPath(subPath string) error {
	if subPath == "" {
		return nil
	}
	if strings.ContainsRune(subPath, 0) ||
		strings.HasPrefix(subPath, "/") ||
		strings.HasSuffix(subPath, "/") ||
		len(subPath) > 4096 ||
		strings.Count(subPath, "/") > 63 {
		return fmt.Errorf("VOLUME_SUBPATH_INVALID: invalid subpath %q", subPath)
	}
	for _, component := range strings.Split(subPath, "/") {
		if component == "" || component == "." || component == ".." || len(component) > 255 {
			return fmt.Errorf("VOLUME_SUBPATH_INVALID: invalid subpath %q", subPath)
		}
	}
	return nil
}

func ensureCloudVolumeRoot(ctx context.Context, path string, label string) error {
	info, err := lstatBounded(ctx, path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("VOLUME_ROOT_NOT_FOUND: %s %s does not exist", label, path)
		}
		return fmt.Errorf("VOLUME_ROOT_INVALID: cannot inspect %s %s: %w", label, path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("VOLUME_ROOT_INVALID: %s %s is a symlink or not a directory", label, path)
	}
	return nil
}

func filestoreTarget(ref *dto.FilestoreRef) string {
	return ref.Server + ":" + ref.Export
}

// normalizeLegacySubPath accepts the old one-trailing-slash spelling and
// stores its equivalent clean relative path. The old join ignored the slash,
// so an API upgrade must not turn a restartable box into VOLUME_SUBPATH_INVALID.
// "a//" was always invalid and stays invalid.
func normalizeLegacySubPath(subPath *string) *string {
	if subPath == nil || *subPath == "" ||
		strings.HasPrefix(*subPath, "/") ||
		!strings.HasSuffix(*subPath, "/") ||
		strings.HasSuffix(*subPath, "//") {
		return subPath
	}
	clean := (*subPath)[:len(*subPath)-1]
	return &clean
}

// lstatBounded gives cloud-backed paths the same bound as mount probes. The
// syscall itself is uninterruptible on a wedged FUSE/NFS mount, so the caller
// returns on the deadline while a leaked goroutine finishes whenever the
// kernel releases it. That is still better than parking every operation for
// the same Filestore instance behind one hung stat.
func lstatBounded(ctx context.Context, path string) (os.FileInfo, error) {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	type lstatResult struct {
		info os.FileInfo
		err  error
	}
	done := make(chan lstatResult, 1)
	go func() {
		info, err := lstatPath(path)
		done <- lstatResult{info: info, err: err}
	}()

	select {
	case result := <-done:
		return result.info, result.err
	case <-probeCtx.Done():
		err := probeCtx.Err()
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("VOLUME_PROBE_TIMEOUT: cannot inspect %s within %s", path, volumeProbeTimeout)
		}
		return nil, fmt.Errorf("VOLUME_PROBE_CANCELLED: cannot inspect %s: %w", path, err)
	}
}

// Replaced only by tests that inject a wedged backend path.
var lstatPath = os.Lstat

// filestoreDataDir derives the volume's data directory inside an instance's
// NFS export: {mount root}/{volume_id}. Volumes are shared resources — boxes
// mounting the same volume land in the same directory, and a destroyed box's
// data stays reachable through the volume id.
func filestoreDataDir(rootPath string, volumeId string) string {
	return filepath.Join(rootPath, volumeId)
}

type filestoreVolumePreparationError struct {
	err error
}

func (e *filestoreVolumePreparationError) Error() string { return e.err.Error() }
func (e *filestoreVolumePreparationError) Unwrap() error { return e.err }

func classifyVolumeMetadataError(volumes []dto.VolumeDTO, err error) error {
	if hasFilestoreRef(volumes) {
		return &filestoreVolumePreparationError{err: err}
	}
	return err
}

func isFilestoreVolumePreparationError(err error) bool {
	var target *filestoreVolumePreparationError
	return errors.As(err, &target)
}

func (c *Client) rejectRecordedFilestoreFallback(boxID string) error {
	record, err := c.readBoxVolumeMountRecord(boxID)
	if err != nil {
		return &filestoreVolumePreparationError{err: fmt.Errorf(
			"FILESTORE_VOLUME_RECORD_UNREADABLE: box %s volume mount record could not be read: %w",
			boxID,
			err,
		)}
	}
	for _, entry := range record.Entries {
		if entry.Backend == volumeBackendFilestore {
			return &filestoreVolumePreparationError{err: fmt.Errorf(
				"FILESTORE_VOLUME_REFERENCE_MISSING: box %s has a recorded Filestore mount but start metadata has no Filestore reference",
				boxID,
			)}
		}
	}
	return nil
}

func (c *Client) ensureVolumeMountsFromMetadata(ctx context.Context, boxID string, metadata map[string]string) error {
	if metadata == nil {
		return nil
	}
	volumesJSON, ok := metadata["volumes"]
	if !ok {
		return nil
	}
	var volumes []dto.VolumeDTO
	if err := json.Unmarshal([]byte(volumesJSON), &volumes); err != nil {
		volumes = nil
	}
	if !hasFilestoreRef(volumes) {
		if err := c.rejectRecordedFilestoreFallback(boxID); err != nil {
			return err
		}
	}
	if len(volumes) == 0 {
		return nil
	}

	volumeMounts, err := c.getVolumeMounts(ctx, boxID, volumes)
	if err != nil {
		return classifyVolumeMetadataError(volumes, err)
	}

	if err := c.recordBoxVolumeMounts(ctx, boxID, volumeMounts); err != nil {
		return classifyVolumeMetadataError(volumes, err)
	}
	return nil
}

func (c *Client) ensureVolumeFuseMounted(ctx context.Context, volumeId string, mountPath string) error {
	volumeMutex := c.volumeMutexFor(volumeId)
	volumeMutex.Lock()
	defer volumeMutex.Unlock()

	// Check the mountpoint itself before probing or mounting through it. A
	// pre-existing symlink must not become the volume boundary.
	if info, err := os.Lstat(mountPath); err == nil && !info.IsDir() {
		return fmt.Errorf("VOLUME_SUBPATH_INVALID: volume mount point %s is a symlink or not a directory", mountPath)
	}

	mounted, err := c.probeMounted(ctx, mountPath)
	if err != nil {
		// Guessing here is what makes a stale mount look absent: we would mount
		// over it, then treat the directory as pre-existing and tear it down.
		return fmt.Errorf("cannot determine whether volume %s is already mounted: %w", volumeId, err)
	}
	if mounted {
		c.logger.DebugContext(ctx, "volume already mounted", "volumeId", volumeId, "mountPath", mountPath)
		return nil
	}

	_, statErr := os.Stat(mountPath)
	dirExisted := statErr == nil

	if err = os.MkdirAll(mountPath, 0755); err != nil {
		return fmt.Errorf("failed to create mount directory %s: %s", mountPath, err)
	}
	// Re-check immediately before the external mount command. This narrows the
	// replacement window; a symlink swapped in after MkdirAll must not become
	// the mount target.
	if info, err := os.Lstat(mountPath); err != nil || !info.IsDir() {
		c.cleanUpFailedMount(ctx, mountPath, dirExisted)
		return fmt.Errorf("VOLUME_ROOT_INVALID: volume mount point %s is a symlink or not a directory", mountPath)
	}

	c.logger.InfoContext(ctx, "mounting volume", "volumeId", volumeId, "mountPath", mountPath, "backend", c.volumeBackend)

	mountCtx, cancelMount := context.WithTimeout(ctx, volumeMountTimeout)
	defer cancelMount()

	cmd := c.getMountCmd(mountCtx, volumeId, mountPath)
	if err = cmd.Run(); err != nil {
		c.cleanUpFailedMount(ctx, mountPath, dirExisted)
		return fmt.Errorf("failed to mount volume %s to %s via %s backend: %s", volumeId, mountPath, c.volumeBackend, err)
	}

	if err = c.waitForMountReady(ctx, mountPath); err != nil {
		c.cleanUpFailedMount(ctx, mountPath, dirExisted)
		return fmt.Errorf("mount %s not ready after mounting: %s", mountPath, err)
	}

	c.logger.InfoContext(ctx, "mounted volume", "volumeId", volumeId, "mountPath", mountPath, "backend", c.volumeBackend)
	return nil
}

func validateFilestoreTarget(ref *dto.FilestoreRef) error {
	if ref.Server == "" || ref.Export == "" {
		return fmt.Errorf("filestore %s requires both server and export", ref.Instance)
	}
	return nil
}

// ensureFilestoreMounted is the NFS twin of ensureVolumeFuseMounted, with two
// deliberate differences. No systemd-run scope: NFS is a kernel mount with no
// daemon, so there is nothing that dies with the runner service's cgroup. And
// no backend flag — the protocol is pinned to NFSv4.1 (the only version the
// Zonal/Regional tiers serve), hard, on the kernel defaults for timeo/retrans.
// Everything else is the same contract: the is-mounted probe, the 90s mount
// timeout (a hard mount to an unreachable server retries forever in the
// foreground — the timeout is what ends it), the readiness wait, and the
// failure cleanup. Unlike its FUSE twin it takes no lock of its own: the
// caller holds the instance mutex so that probing, mounting, preparing the
// data directory and writing the referencing record form ONE critical section
// against reclaim (design §4.5).
func (c *Client) ensureFilestoreMounted(ctx context.Context, ref *dto.FilestoreRef, mountRoot string, mountKey string) error {
	if err := validateFilestoreTarget(ref); err != nil {
		return err
	}

	if info, err := os.Lstat(mountRoot); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("VOLUME_ROOT_INVALID: filestore mount root %s is a symlink or not a directory", mountRoot)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("VOLUME_ROOT_INVALID: cannot inspect filestore mount root %s: %w", mountRoot, err)
	}

	mounted, err := c.probeMounted(ctx, mountRoot)
	if err != nil {
		// Same reasoning as the FUSE twin: guessing here is what makes a stale
		// mount look absent, and mounting over a live NFS mount wedges both.
		return fmt.Errorf("cannot determine whether filestore %s is already mounted: %w", ref.Instance, err)
	}
	if mounted {
		if err := verifyFilestoreMountTarget(ctx, ref, mountRoot); err != nil {
			return err
		}
		c.logger.DebugContext(ctx, "filestore already mounted", "instance", ref.Instance, "mountRoot", mountRoot)
		return nil
	}

	_, statErr := os.Stat(mountRoot)
	dirExisted := statErr == nil

	if err = os.MkdirAll(mountRoot, 0755); err != nil {
		return fmt.Errorf("failed to create filestore mount root %s: %s", mountRoot, err)
	}
	if info, err := os.Lstat(mountRoot); err != nil || !info.IsDir() {
		c.cleanUpFailedMount(ctx, mountRoot, dirExisted)
		return fmt.Errorf("VOLUME_ROOT_INVALID: filestore mount root %s is a symlink or not a directory", mountRoot)
	}

	// Establish the ownership boundary before the mount starts. If the caller
	// times out, late completion can prove this mount unreferenced and reclaim it;
	// existing mounts return above without weakening the missing-records guard.
	recordDir := getVolumeMountRecordDir()
	if err = os.MkdirAll(recordDir, 0755); err != nil {
		c.cleanUpFailedMount(ctx, mountRoot, dirExisted)
		return fmt.Errorf("failed to create volume mount record directory %s: %w", recordDir, err)
	}

	c.logger.InfoContext(ctx, "mounting filestore instance", "instance", ref.Instance, "server", ref.Server, "export", ref.Export, "mountRoot", mountRoot)

	mountCtx, cancelMount := context.WithTimeout(ctx, volumeMountTimeout)
	defer cancelMount()

	cmd := c.getNfsMountCmd(mountCtx, ref, mountRoot)
	pending, mountErr := c.runMount(mountCtx, mountKey, cmd, mountRoot)
	if mountErr != nil {
		if !pending {
			c.cleanUpFailedMount(ctx, mountRoot, dirExisted)
		}
		return fmt.Errorf("failed to mount filestore %s to %s: %w", ref.Instance, mountRoot, mountErr)
	}

	if err = c.waitForMountReady(ctx, mountRoot); err != nil {
		c.cleanUpFailedMount(ctx, mountRoot, dirExisted)
		return fmt.Errorf("mount %s not ready after mounting: %s", mountRoot, err)
	}

	c.logger.InfoContext(ctx, "mounted filestore instance", "instance", ref.Instance, "mountRoot", mountRoot)
	return nil
}

func verifyFilestoreMountTarget(ctx context.Context, ref *dto.FilestoreRef, mountRoot string) error {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	expected := filestoreTarget(ref)
	output, err := exec.CommandContext(
		probeCtx,
		"findmnt",
		"--noheadings",
		"--nofsroot",
		"--raw",
		"--mountpoint", mountRoot,
		"--types", "nfs4",
		"--output", "SOURCE",
	).Output()
	if err != nil {
		return fmt.Errorf("cannot verify existing filestore %s mount at %s as NFSv4 with source %s: %w", ref.Instance, mountRoot, expected, err)
	}
	actual := strings.TrimSpace(string(output))
	if actual != expected {
		return fmt.Errorf("filestore %s mount target mismatch at %s: mounted source %q, requested source %q", ref.Instance, mountRoot, actual, expected)
	}
	return nil
}

// nfsMountArgs builds the argv for one mount(8) invocation: NFSv4.1 and hard,
// with kernel defaults for timeo/retrans. A pure function so a test can pin
// the argv — the protocol and retry posture are design-pinned and are the
// contract with the API's Filestore discovery.
func nfsMountArgs(ref *dto.FilestoreRef, path string) []string {
	opts := "vers=4.1,hard"
	return []string{"-t", "nfs", "-o", opts, filestoreTarget(ref), path}
}

// getNfsMountCmd wraps nfsMountArgs in the command to run. No systemd-run
// scope here, unlike the FUSE backends: NFS is a kernel mount with no daemon,
// so nothing dies with the runner service's cgroup and the plain
// context-bound exec is the whole story. Output goes to the same log writers
// the FUSE mounts use, so a failing mount shows up in the runner's logs.
func (c *Client) getNfsMountCmd(ctx context.Context, ref *dto.FilestoreRef, path string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "mount", nfsMountArgs(ref, path)...)
	cmd.Env = os.Environ()
	cmd.Stderr = io.Writer(&log.ErrorLogWriter{})
	cmd.Stdout = io.Writer(&log.InfoLogWriter{})
	return cmd
}

// runMount supervises the command so an unkillable process cannot park the
// caller after the deadline. The pending marker prevents a retry or reclaim
// from treating that process as finished before Wait returns. Once an abandoned
// mount finishes, reference-aware reclaim runs with that marker cleared.
func (c *Client) runMount(ctx context.Context, mountKey string, cmd *exec.Cmd, mountRoot string) (bool, error) {
	return c.runBoundedVolumeOperation(ctx, mountKey, func() error {
		if c.testMountRunner != nil {
			return c.testMountRunner(cmd)
		}
		return cmd.Run()
	}, func() {
		c.reclaimFilestoreMount(context.Background(), mountRoot)
	})
}

// mountProbeCmd and umountCmd exist as separate builders so a test can assert
// the commands are context-bound. Running them cannot show that: mountpoint
// and umount fail on an ordinary directory whatever the context says.
func mountProbeCmd(ctx context.Context, path string) *exec.Cmd {
	return exec.CommandContext(ctx, "mountpoint", path)
}

func umountCmd(ctx context.Context, path string) *exec.Cmd {
	return exec.CommandContext(ctx, "umount", path)
}

// cleanupContext detaches from the caller's cancellation while keeping its
// values, and gives the teardown a bound of its own. Extracted so a test can
// hold it to that: derived straight from ctx, the whole cleanup becomes a
// no-op in the cases that call it.
func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), volumeProbeTimeout*2)
}

// cleanUpFailedMount undoes a mount attempt that did not reach a usable state.
//
// It deliberately does not use the caller's context. The two things that bring
// us here — volumeMountTimeout firing, and the client disconnecting — both
// leave that context cancelled, and every exec under a cancelled context
// returns without running. Inheriting it would mean the cleanup silently does
// nothing in exactly the cases it exists for.
//
// The unmount is not gated on dirExisted: a mount tool can attach to a
// directory that was already there, and leaving that behind is the worse
// failure. A later ensureVolumeFuseMounted would see isDirectoryMounted report
// true and hand a box a wedged mount. Only removing the directory is gated,
// because only then did we create it.
func (c *Client) cleanUpFailedMount(ctx context.Context, mountPath string, dirExisted bool) {
	cleanupCtx, cancel := cleanupContext(ctx)
	defer cancel()

	var unmountErr error
	mounted, probeErr := c.isDirectoryMounted(cleanupCtx, mountPath)
	if probeErr != nil {
		// Unknown state: leave both the mount and the directory alone rather
		// than remove a path that may still be a live mountpoint.
		c.logger.WarnContext(ctx, "skipping mount cleanup, probe inconclusive", "path", mountPath, "error", probeErr)
		return
	}
	if mounted {
		if unmountErr = c.umountPath(cleanupCtx, mountPath); unmountErr != nil {
			c.logger.WarnContext(ctx, "failed to unmount after failed mount", "path", mountPath, "error", unmountErr)
		}
	}

	if shouldRemoveMountDir(dirExisted, unmountErr) {
		if err := os.Remove(mountPath); err != nil {
			c.logger.WarnContext(ctx, "failed to remove mount directory", "path", mountPath, "error", err)
		}
	}
}

// shouldRemoveMountDir keeps the teardown ordering honest. The directory goes
// only when we created it AND nothing is still mounted on it: removing a live
// mountpoint stranded the mount under an empty path, and removing a directory
// we did not create destroys someone else's.
func shouldRemoveMountDir(dirExisted bool, unmountErr error) bool {
	return !dirExisted && unmountErr == nil
}

// isDirectoryMounted answers whether path is a mountpoint. The error is
// non-nil only when the probe could not run to an answer — a finished context,
// a deadline hit mid-probe, or no `mountpoint` binary to run at all.
//
// The two must stay distinguishable. A probe that cannot run and reports
// "false" is not a harmless default: callers use it to decide whether a mount
// is already in place and whether one is theirs to tear down, so the false
// negative makes them remount over a live mount, or unmount someone else's.
func (c *Client) isDirectoryMounted(ctx context.Context, path string) (bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	_, err := mountProbeCmd(probeCtx, path).Output()
	if probeCtx.Err() != nil {
		return false, fmt.Errorf("mount probe on %s did not complete: %w", path, probeCtx.Err())
	}
	if err == nil {
		return true, nil
	}

	// A non-zero exit is mountpoint's way of saying "not a mountpoint"; any
	// other failure means we never got an answer.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return false, nil
	}
	// Still no answer, but the two reasons are fixed in different places: a
	// host without util-linux has no `mountpoint` to run, which is the
	// provisioning's problem, not this path's. Saying so here saves the reader
	// looking for a mount that was never inspected.
	if errors.Is(err, exec.ErrNotFound) {
		return false, fmt.Errorf("mount probe on %s cannot run: mountpoint is not installed on this host: %w", path, err)
	}
	return false, fmt.Errorf("mount probe on %s failed: %w", path, err)
}

// umountPath tears a mount down under the same bound as the probe: a mount
// whose backend is gone will not answer, and an unbounded umount here would
// simply move the hang from the mount to its cleanup.
func (c *Client) umountPath(ctx context.Context, path string) error {
	umountCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	return umountCmd(umountCtx, path).Run()
}

// probeMounted answers whether path is a mountpoint, through the injectable
// probe when a test installed one. The mount seam alone cannot make the
// concurrency test decidable on every host: the readiness wait reads a host
// binary (`mountpoint`), which a dev machine may not have. Production keeps
// the real probe — NewClient sets neither seam.
func (c *Client) probeMounted(ctx context.Context, path string) (bool, error) {
	if c.testProbeRunner != nil {
		return c.testProbeRunner(ctx, path)
	}
	return c.isDirectoryMounted(ctx, path)
}

func (c *Client) checkVolumeOperation(key string) error {
	c.volumeMutexesMutex.Lock()
	defer c.volumeMutexesMutex.Unlock()
	if c.volumePending[key] > 0 {
		return fmt.Errorf("previous volume operation for %s is still in flight", key)
	}
	return nil
}

// trackLateVolumeOperation keeps an instance marked busy until the underlying
// syscall or process has actually finished, even after its caller timed out.
func (c *Client) trackLateVolumeOperation(key string, done <-chan error, onComplete func()) {
	c.volumeMutexesMutex.Lock()
	if c.volumePending == nil {
		c.volumePending = make(map[string]int)
	}
	c.volumePending[key]++
	c.volumeMutexesMutex.Unlock()

	go func() {
		err := <-done
		c.volumeMutexesMutex.Lock()
		c.volumePending[key]--
		if c.volumePending[key] == 0 {
			delete(c.volumePending, key)
		}
		c.volumeMutexesMutex.Unlock()
		if err != nil {
			c.logger.WarnContext(context.Background(), "late volume operation failed", "key", key, "error", err)
		}
		if onComplete != nil {
			onComplete()
		}
	}()
}

// runBoundedVolumeOperation returns on context completion while retaining an
// instance-level pending marker until the operation itself finishes.
func (c *Client) runBoundedVolumeOperation(ctx context.Context, key string, operation func() error, onLateCompletion func()) (bool, error) {
	done := make(chan error, 1)
	go func() {
		done <- operation()
	}()

	select {
	case err := <-done:
		return false, err
	case <-ctx.Done():
		c.trackLateVolumeOperation(key, done, onLateCompletion)
		return true, ctx.Err()
	}
}

// volumeMutexFor returns the per-key mutex for a mount key, creating it on
// first use. The key was the volume id for object storage; it generalizes to
// the prefixed instance name for filestore, so one instance's ensure-mount,
// reclaim decision and in-lock record rescan all serialize on one lock.
func (c *Client) volumeMutexFor(key string) *sync.Mutex {
	c.volumeMutexesMutex.Lock()
	defer c.volumeMutexesMutex.Unlock()
	// Tests construct Clients without the map; lazily create it so every
	// lock-taking path is safe on any Client. NewClient still initializes it.
	if c.volumeMutexes == nil {
		c.volumeMutexes = make(map[string]*sync.Mutex)
	}
	volumeMutex, exists := c.volumeMutexes[key]
	if !exists {
		volumeMutex = &sync.Mutex{}
		c.volumeMutexes[key] = volumeMutex
	}
	return volumeMutex
}

// readable answers whether the mountpoint can be listed, without inheriting a
// hang if it cannot. os.Stat and os.ReadDir are uninterruptible on a FUSE mount
// whose daemon has attached and then wedged — exactly the state this readiness
// loop exists to detect — so the syscalls run on their own goroutine and the
// caller stops waiting on the bound. That goroutine stays parked until the
// kernel releases it; the alternative is parking the whole box creation.
func readable(ctx context.Context, path string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, volumeProbeTimeout)
	defer cancel()

	done := make(chan bool, 1)
	go func() {
		if _, err := os.Stat(path); err != nil {
			done <- false
			return
		}
		_, err := os.ReadDir(path)
		done <- err == nil
	}()

	select {
	case ok := <-done:
		return ok
	case <-probeCtx.Done():
		return false
	}
}

// notReadyError names why the readiness wait ended: the caller gave up, or the
// mount simply never came up within our own bound. Both reach here through the
// same finished readyCtx, so the caller's context is what tells them apart.
func notReadyError(ctx context.Context, readyCtx context.Context) error {
	if ctx.Err() != nil {
		return fmt.Errorf("context cancelled while waiting for mount ready: %w", ctx.Err())
	}
	return fmt.Errorf("mount did not become ready within %s: %w", volumeReadyTimeout, readyCtx.Err())
}

func (c *Client) waitForMountReady(ctx context.Context, path string) error {
	sleepDuration := 100 * time.Millisecond

	readyCtx, cancel := context.WithTimeout(ctx, volumeReadyTimeout)
	defer cancel()

	for attempt := 1; ; attempt++ {
		mounted, err := c.probeMounted(readyCtx, path)
		if err != nil {
			return notReadyError(ctx, readyCtx)
		}
		if !mounted {
			return fmt.Errorf("mount disappeared during readiness check")
		}

		if readable(readyCtx, path) {
			c.logger.InfoContext(ctx, "mount is ready", "path", path, "attempts", attempt)
			return nil
		}

		select {
		case <-readyCtx.Done():
			return notReadyError(ctx, readyCtx)
		case <-time.After(sleepDuration):
		}
	}
}

// Volume storage backends the runner can mount with, selected by
// VOLUME_STORAGE_BACKEND. The default is s3, so a deployment that does not set
// it keeps mount-s3 and its exact argv.
//
// Each value names a binary the host must already provide — s3 needs mount-s3,
// gcs needs gcsfuse 2.0 or later, which is where --metadata-cache-ttl-secs
// replaced --stat-cache-ttl — and neither is installed by the runner. Verified
// against mount-s3 1.20.0 and gcsfuse 3.8.4. The API must be set to the same
// backend: it creates the buckets mounted here.
const (
	volumeBackendS3  = "s3"
	volumeBackendGCS = "gcs"
	// filestore is not selectable by VOLUME_STORAGE_BACKEND — that flag
	// chooses the bucket backend, and a Filestore mount is chosen per volume
	// reference instead. The label only ever appears in mount records.
	volumeBackendFilestore = "filestore"
)

// The permission bits both mounts present. Paired with allow_other, they are
// what lets a process other than the mounting one use the mount. The two
// backends carry the same setting, so the literals live here rather than once
// per backend where they could drift apart.
const (
	volumeFileMode = "0666"
	volumeDirMode  = "0777"
)

// mountSpec is one backend's mount invocation. Keeping the binary, its argv
// and its credential environment together is what lets wrapMountCmd stay
// backend-agnostic.
type mountSpec struct {
	bin  string
	args []string
	env  []string
}

func (c *Client) getMountCmd(ctx context.Context, volume string, path string) *exec.Cmd {
	if c.volumeBackend == volumeBackendGCS {
		return c.wrapMountCmd(ctx, gcsfuseMountSpec(volume, path))
	}
	return c.wrapMountCmd(ctx, c.mountS3Spec(volume, path))
}

// mountS3Spec builds the Mountpoint for Amazon S3 invocation. Credentials are
// injected only when configured: a runner host sets none of them, so mount-s3
// falls through to the EC2 instance role.
func (c *Client) mountS3Spec(bucket string, path string) mountSpec {
	args := []string{"--allow-other", "--allow-delete", "--allow-overwrite", "--file-mode", volumeFileMode, "--dir-mode", volumeDirMode}
	args = append(args, bucket, path)

	var envVars []string
	if c.awsEndpointUrl != "" {
		envVars = append(envVars, "AWS_ENDPOINT_URL="+c.awsEndpointUrl)
	}
	if c.awsAccessKeyId != "" {
		envVars = append(envVars, "AWS_ACCESS_KEY_ID="+c.awsAccessKeyId)
	}
	if c.awsSecretAccessKey != "" {
		envVars = append(envVars, "AWS_SECRET_ACCESS_KEY="+c.awsSecretAccessKey)
	}
	if c.awsRegion != "" {
		envVars = append(envVars, "AWS_REGION="+c.awsRegion)
	}

	return mountSpec{bin: "mount-s3", args: args, env: envVars}
}

// gcsfuseMountSpec builds the Cloud Storage FUSE invocation. It is not a
// one-to-one translation of mountS3Spec's argv:
//
//   - --allow-delete and --allow-overwrite have no counterpart because gcsfuse
//     permits both by default; passing them is a hard "unknown flag" error.
//   - --implicit-dirs is required for parity. Without it a directory that
//     exists only as an object-name prefix is invisible, while mount-s3 shows it.
//   - --metadata-cache-ttl-secs is pinned to 0 because gcsfuse otherwise caches
//     metadata for 60s, while mount-s3 defaults to strong read-after-write
//     consistency. Inheriting the gcsfuse default would silently hand a box a
//     staleness window it does not have today. Raising this is the first knob to
//     reach for once GCS request volume is measured.
//
// The spec contributes no credential environment of its own; gcsfuse resolves
// Application Default Credentials, which on GCE is the attached instance
// service account. The runner's own environment is still passed through, which
// is what lets a GOOGLE_APPLICATION_CREDENTIALS path work off-GCE.
// Keeping a secret off the argv is not what the empty spec buys — wrapMountCmd
// does that for both backends now — so this is simply a backend with no
// credential of its own to carry.
func gcsfuseMountSpec(bucket string, path string) mountSpec {
	return mountSpec{
		bin: "gcsfuse",
		args: []string{
			"-o", "allow_other",
			"--file-mode", volumeFileMode,
			"--dir-mode", volumeDirMode,
			"--implicit-dirs",
			"--metadata-cache-ttl-secs", "0",
			bucket, path,
		},
	}
}

// wrapMountCmd turns a spec into the command to run.
//
// On a systemd host the mount is launched in its own transient scope. A FUSE
// daemon started as a plain child of the runner service lands in that service's
// cgroup, so the next `systemctl restart boxlite-runner` kills every mount and
// leaves the boxes bound to them reading a dead mountpoint.
//
// Both branches bind the context so volumeMountTimeout can kill a mount command
// that never returns; the request context alone carries no deadline. The kill
// reaches the foreground process only — a mount tool that has already forked its
// FUSE daemon leaves that daemon behind, which is what the unmount in the
// caller's failure path is for.
func (c *Client) wrapMountCmd(ctx context.Context, spec mountSpec) *exec.Cmd {
	cmd := exec.CommandContext(ctx, spec.bin, spec.args...)

	if _, err := os.Stat("/run/systemd/system"); err == nil {
		sdArgs := []string{"--scope", "--", spec.bin}
		sdArgs = append(sdArgs, spec.args...)
		cmd = exec.CommandContext(ctx, "systemd-run", sdArgs...)
	}

	// One environment, set after the branch rather than inside it, so the two
	// paths cannot drift. The spec's credentials go here and never on the argv:
	// under --scope systemd-run runs the mount tool as its child and passes this
	// down, while an AWS_SECRET_ACCESS_KEY in the command line is readable by
	// `ps` to every user on the host for as long as the mount lives.
	// os.Environ() underneath because the mount tool needs PATH, the proxy and
	// CA settings, and any AWS_SESSION_TOKEN the runner holds; a spec entry wins
	// over an ambient one of the same name, which is how exec resolves a
	// duplicate.
	cmd.Env = append(os.Environ(), spec.env...)

	cmd.Stderr = io.Writer(&log.ErrorLogWriter{})
	cmd.Stdout = io.Writer(&log.InfoLogWriter{})

	return cmd
}

// readBoxVolumeMountRecord reads a box's record from disk. A missing record is
// not an error: it means no create or replay ever wrote one for the box, which
// is the empty record — a caller merging into it starts from nothing rather
// than failing the merge.
//
// Parsed through a neutral alias rather than the record's own UnmarshalJSON.
// That reader folds the legacy paths into entries unconditionally, and a
// read-modify-write cycle through it (the merge) would copy the folded
// duplicates back into the file's entries on every write — the record would
// grow by its paths count per merge. The two shapes are distinguished instead:
// a record with entries carries its content in entries (paths is the derived
// legacy mirror every writer emits alongside them), and only a pre-entries
// record keeps its references in paths, folded here into s3 entries exactly as
// the compat reader folds them.
func (c *Client) readBoxVolumeMountRecord(boxID string) (*boxVolumeMountRecord, error) {
	path := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &boxVolumeMountRecord{BoxID: boxID}, nil
		}
		return nil, err
	}

	var alias struct {
		BoxID   string                `json:"boxId"`
		Paths   []string              `json:"paths"`
		Entries []boxVolumeMountEntry `json:"entries"`
	}
	if err := json.Unmarshal(data, &alias); err != nil {
		return nil, err
	}

	record := &boxVolumeMountRecord{BoxID: alias.BoxID, Entries: alias.Entries}
	if len(alias.Entries) == 0 {
		for _, legacyPath := range alias.Paths {
			record.Entries = append(record.Entries, boxVolumeMountEntry{Backend: volumeBackendS3, RootPath: legacyPath})
		}
	}
	if record.BoxID == "" {
		record.BoxID = boxID
	}
	return record, nil
}

// mergeBoxVolumeMountRecord adds mounts' entries to the box's existing record
// and rewrites it, keeping every entry already on disk. It is the in-lock
// write of filestoreVolumeMount, where an in-lock replacement would publish
// just the processed prefix: a volume list whose later volume fails would
// leave the record truncated while the box kept every mount, handing the
// orphan reclaimer live references. The full rewrite that ends a successful
// volume list (recordBoxVolumeMounts) is what makes the record exact again.
func (c *Client) mergeBoxVolumeMountRecord(ctx context.Context, boxID string, mounts []volumeMount) error {
	if boxID == "" || len(mounts) == 0 {
		return nil
	}

	record, err := c.readBoxVolumeMountRecord(boxID)
	if err != nil {
		return err
	}

	// boxVolumeMountEntry is comparable, so it keys the seen-set directly: an
	// entry already on disk (or repeated within this call) is kept as-is, not
	// duplicated.
	seen := make(map[boxVolumeMountEntry]bool, len(record.Entries)+len(mounts))
	for _, entry := range record.Entries {
		seen[entry] = true
	}
	for _, mount := range mounts {
		entry := boxVolumeMountEntry{
			Backend:           mount.backend,
			RootPath:          normalizeVolumePath(mount.rootPath),
			FilestoreInstance: mount.filestoreInstance,
		}
		// dataDir is filestore-only; an empty one stays absent rather than
		// normalized into a meaningless "."
		if mount.dataDir != "" {
			entry.DataDir = normalizeVolumePath(mount.dataDir)
		}
		if !seen[entry] {
			seen[entry] = true
			record.Entries = append(record.Entries, entry)
		}
	}

	// paths (legacy) is rebuilt from the merged entries under the same deduped
	// rootPath rule recordBoxVolumeMounts writes, so both record readers keep
	// seeing the same reference set.
	record.Paths = dedupedRootPaths(record.Entries)

	return c.writeBoxVolumeMountRecord(ctx, boxID, *record)
}

func (c *Client) recordBoxVolumeMounts(ctx context.Context, boxID string, mounts []volumeMount) error {
	if boxID == "" || len(mounts) == 0 {
		return nil
	}

	// One entry per declared volume. The reclaimer dedups by rootPath, so a
	// box mounting the same instance twice keeps both data directories on
	// record while counting the mount root once.
	entries := make([]boxVolumeMountEntry, 0, len(mounts))
	for _, mount := range mounts {
		entry := boxVolumeMountEntry{
			Backend:           mount.backend,
			RootPath:          normalizeVolumePath(mount.rootPath),
			FilestoreInstance: mount.filestoreInstance,
		}
		// dataDir is filestore-only; an empty one stays absent rather than
		// normalized into a meaningless "."
		if mount.dataDir != "" {
			entry.DataDir = normalizeVolumePath(mount.dataDir)
		}
		entries = append(entries, entry)
	}

	record := boxVolumeMountRecord{
		BoxID:   boxID,
		Entries: entries,
		Paths:   dedupedRootPaths(entries),
	}

	return c.writeBoxVolumeMountRecord(ctx, boxID, record)
}

// dedupedRootPaths builds the legacy Paths field from entries: the deduped
// rootPath set, in entry order.
//
// paths is written alongside entries for one release cycle: a runner binary
// rolled back to the pre-entries version reads only Paths, and an entries-only
// record would read as zero references — its cleanup would then reclaim live
// mounts. The deduped rootPath set serves both readers. Stop writing it once a
// rollback to a pre-entries binary is no longer possible (remove this helper
// and the struct's Paths field).
func dedupedRootPaths(entries []boxVolumeMountEntry) []string {
	paths := make([]string, 0, len(entries))
	seenRoot := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if !seenRoot[entry.RootPath] {
			seenRoot[entry.RootPath] = true
			paths = append(paths, entry.RootPath)
		}
	}
	return paths
}

// writeBoxVolumeMountRecord persists one box's record: marshal, ensure the
// record directory, write a uniquely named temp sibling, rename over the
// record. Every writer of a record — the full rewrite and the in-lock merge —
// goes through here, so the seam check sits at the top of this function and
// covers them both.
func (c *Client) writeBoxVolumeMountRecord(ctx context.Context, boxID string, record boxVolumeMountRecord) error {
	if c.writeRecordSeam != nil {
		return c.writeRecordSeam(ctx, boxID, record)
	}

	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("failed to marshal volume mount record for box %s: %w", boxID, err)
	}

	dir := getVolumeMountRecordDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create volume mount record directory %s: %w", dir, err)
	}

	path := filepath.Join(dir, boxID+".json")
	// Write to a uniquely named sibling temp file and rename. A reader
	// mid-file (the orphan reclaimer scans every record) must see the old
	// content or the new content, never a torn half of both; rename is atomic
	// on the same filesystem. The unique name keeps two concurrent writers of
	// the same box's record (create replay) from truncating each other's temp
	// file, and it never ends in .json, so the scanner skips it.
	tmp, err := os.CreateTemp(dir, boxID+".json.*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp volume mount record in %s: %w", dir, err)
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("failed to write volume mount record %s: %w", tmpPath, err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to close volume mount record %s: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to replace volume mount record %s: %w", path, err)
	}

	c.logger.DebugContext(ctx, "recorded box volume mounts", "box", boxID, "entries", len(record.Entries))
	return nil
}

func (c *Client) removeBoxVolumeMountRecord(ctx context.Context, boxID string) error {
	if boxID == "" {
		return nil
	}

	path := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	c.logger.DebugContext(ctx, "removed box volume mount record", "box", boxID)
	return nil
}

// removeBoxVolumeMountRecordLocked deletes a box's record under each
// referenced filestore instance's mutex, in turn. A reclaim decision for an
// instance runs under that instance's lock; deleting the record under the
// same lock means the deletion cannot interleave with an in-flight "is this
// mount referenced?" decision for any of the instances the box used (design
// §4.5.3). The file is deleted once — the call is idempotent for the
// remaining instances. Without filestore instances the plain unlocked delete
// keeps the object-storage behavior exactly as it was.
func (c *Client) removeBoxVolumeMountRecordLocked(ctx context.Context, boxID string, instances []string) error {
	return c.mutateBoxVolumeMountRecordLocked(ctx, boxID, instances, func() error {
		return c.removeBoxVolumeMountRecord(ctx, boxID)
	})
}

func (c *Client) mutateBoxVolumeMountRecordLocked(ctx context.Context, boxID string, instances []string, mutate func() error) error {
	locked := make(map[string]bool, len(instances))
	var firstErr error
	for _, instance := range instances {
		if locked[instance] {
			continue
		}
		locked[instance] = true

		mutex := c.volumeMutexFor(filestoreMountPrefix + instance)
		mutex.Lock()
		err := mutate()
		mutex.Unlock()
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if len(locked) == 0 {
		return mutate()
	}
	return firstErr
}

// hasFilestoreRef answers whether the box declares any Filestore volume.
// Only a filestore volume writes its record entry inside the instance
// critical section -- before the volume list completes -- so it is the only
// kind that can leave a partial record behind a getVolumeMounts failure; an
// object-storage-only list writes its record only after the list succeeds.
func hasFilestoreRef(volumes []dto.VolumeDTO) bool {
	for _, vol := range volumes {
		if vol.Filestore != nil {
			return true
		}
	}
	return false
}

// rollbackVolumeMountRecord removes entries owned by a failed attempt without
// discarding references that an existing box recorded before a replay began.
// After a successful record rollback, it reclaims only the declared Filestore
// roots that remain unreferenced.
func (c *Client) rollbackVolumeMountRecord(ctx context.Context, boxID string, volumes []dto.VolumeDTO, prior *boxVolumeMountRecord) {
	var filestoreInstances []string
	for _, vol := range volumes {
		if vol.Filestore != nil {
			filestoreInstances = append(filestoreInstances, vol.Filestore.Instance)
		}
	}
	if prior != nil {
		for _, entry := range prior.Entries {
			if entry.FilestoreInstance != "" {
				filestoreInstances = append(filestoreInstances, entry.FilestoreInstance)
			}
		}
	}

	err := c.mutateBoxVolumeMountRecordLocked(ctx, boxID, filestoreInstances, func() error {
		if prior == nil || len(prior.Entries) == 0 {
			return c.removeBoxVolumeMountRecord(ctx, boxID)
		}
		restored := *prior
		restored.Paths = dedupedRootPaths(restored.Entries)
		return c.writeBoxVolumeMountRecord(ctx, boxID, restored)
	})
	if err != nil {
		c.logger.WarnContext(ctx, "failed to restore box volume mount record after create failure", "box", boxID, "error", err)
		return
	}

	seen := make(map[string]bool)
	for _, instance := range filestoreInstances {
		if seen[instance] || !filestoreInstanceNamePattern.MatchString(instance) {
			continue
		}
		seen[instance] = true
		root := filepath.Join(getVolumeMountBasePath(), filestoreMountPrefix+instance)
		cleanupCtx, cancel := cleanupContext(ctx)
		c.reclaimFilestoreMount(cleanupCtx, root)
		cancel()
	}
}

// readFilestoreInstancesFromRecord parses a box's record and returns the
// distinct filestore instance names it references. A missing record is not an
// error — the box had no volumes, so there is nothing to lock.
func (c *Client) readFilestoreInstancesFromRecord(boxID string) ([]string, error) {
	path := filepath.Join(getVolumeMountRecordDir(), boxID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var record boxVolumeMountRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var instances []string
	for _, entry := range record.Entries {
		if entry.FilestoreInstance != "" && !seen[entry.FilestoreInstance] {
			seen[entry.FilestoreInstance] = true
			instances = append(instances, entry.FilestoreInstance)
		}
	}
	return instances, nil
}

func getVolumeMountRecordDir() string {
	return filepath.Join(getVolumeMountBasePath(), volumeMountRecordDir)
}

func normalizeVolumePath(path string) string {
	return strings.TrimRight(filepath.Clean(path), "/")
}

// CleanupOrphanedVolumeMounts removes S3/FUSE volume mounts no longer referenced by known boxes.
func (c *Client) CleanupOrphanedVolumeMounts(ctx context.Context) {
	c.volumeCleanupMutex.Lock()
	defer c.volumeCleanupMutex.Unlock()

	if c.volumeCleanup.interval > 0 && time.Since(c.lastVolumeCleanup) < c.volumeCleanup.interval {
		return
	}
	c.lastVolumeCleanup = time.Now()

	// Both mount families live directly under the base: object-storage bucket
	// mounts (`boxlite-volume-*`) and filestore NFS mounts
	// (`boxlite-filestore-*`). Scanning only one family would leave the other
	// family's orphans on the host forever.
	mountDirs, err := c.globOrphanCandidates()
	if err != nil || len(mountDirs) == 0 {
		return
	}

	inUse, err := c.getRecordedVolumeMounts()
	if err != nil {
		c.logger.ErrorContext(ctx, "volume cleanup aborted", "error", err)
		return
	}

	c.logger.InfoContext(ctx, "volume cleanup", "dry-run", c.volumeCleanup.dryRun)

	for _, dir := range mountDirs {
		if inUse[normalizeVolumePath(dir)] {
			continue
		}

		// Filestore uses its instance lock, record rescan and pending marker to
		// guard new mounts. Checking recency first would stat a hard NFS mount,
		// which can block forever when the server is unreachable.
		if strings.HasPrefix(filepath.Base(dir), filestoreMountPrefix) {
			if c.volumeCleanup.dryRun {
				c.logger.InfoContext(ctx, "[DRY-RUN] would clean orphaned volume mount", "path", dir)
				continue
			}
			c.logger.InfoContext(ctx, "cleaning orphaned filestore mount", "path", dir)
			c.reclaimFilestoreMount(ctx, dir)
			continue
		}
		if c.isRecentlyCreated(dir, c.volumeCleanup.exclusionPeriod) {
			continue
		}
		if c.volumeCleanup.dryRun {
			c.logger.InfoContext(ctx, "[DRY-RUN] would clean orphaned volume mount", "path", dir)
			continue
		}

		c.logger.InfoContext(ctx, "cleaning orphaned volume mount", "path", dir)
		c.unmountAndRemoveDir(ctx, dir)
	}
}

// globOrphanCandidates lists the mount roots of both volume families.
func (c *Client) globOrphanCandidates() ([]string, error) {
	base := getVolumeMountBasePath()
	var dirs []string
	for _, prefix := range []string{volumeMountPrefix, filestoreMountPrefix} {
		matches, err := filepath.Glob(filepath.Join(base, prefix+"*"))
		if err != nil {
			return nil, err
		}
		dirs = append(dirs, matches...)
	}
	return dirs, nil
}

// reclaimFilestoreMount tears down one instance's NFS mount root after
// re-checking the records under the instance's own mutex. The outer cleanup
// loop decided "orphaned" from a scan that is stale the moment it finishes.
// The rescan alone would not close that window: a create between the outer
// scan and this lock would still have its record unwritten. It closes because
// the other side holds this same lock — filestoreVolumeMount keeps the
// instance mutex across mount + data-dir + record write (design §4.5.2), so a
// reference either predates this lock (the rescan sees it) or can only arrive
// after it is released. A mount that reads unreferenced here is genuinely
// unreferenced.
func (c *Client) reclaimFilestoreMount(ctx context.Context, dir string) {
	mountKey := filepath.Base(dir)
	mutex := c.volumeMutexFor(mountKey)
	mutex.Lock()
	defer mutex.Unlock()
	if err := c.checkVolumeOperation(mountKey); err != nil {
		c.logger.DebugContext(ctx, "skipping filestore reclaim while an operation is in flight", "mountRoot", dir)
		return
	}

	inUse, err := c.getRecordedVolumeMounts()
	if err != nil {
		// The reclaimer only ever acts on what the records prove. A record
		// read that fails proves nothing, so the mount survives this round.
		c.logger.WarnContext(ctx, "skipping filestore reclaim, records unreadable", "path", dir, "error", err)
		return
	}
	if inUse[normalizeVolumePath(dir)] {
		c.logger.InfoContext(ctx, "filestore mount became referenced during cleanup, keeping it", "path", dir)
		return
	}

	c.unmountAndRemoveDir(ctx, dir)
}

func (c *Client) getRecordedVolumeMounts() (map[string]bool, error) {
	inUse := make(map[string]bool)
	recordDir := getVolumeMountRecordDir()

	entries, err := os.ReadDir(recordDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("volume mount record directory %s does not exist; refusing to clean existing mounts without ownership records", recordDir)
		}
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(recordDir, entry.Name()))
		if err != nil {
			return nil, err
		}

		var record boxVolumeMountRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return nil, err
		}

		for _, mountEntry := range record.Entries {
			cleanPath := normalizeVolumePath(mountEntry.RootPath)
			if isOwnedMountPath(cleanPath) {
				inUse[cleanPath] = true
			}
		}
	}

	return inUse, nil
}

// isOwnedMountPath answers whether a path sits under one of the prefixes the
// runner mounts volumes at — object storage (`boxlite-volume-`) and filestore
// (`boxlite-filestore-`). The reclaimer checks this in three places: the
// directory scan, the in-use filter, and the unmount guard. All three must
// accept the same set of paths; a guard that misses filestore roots would
// either reclaim a referenced NFS mount (destroying dataDir visibility) or
// never reclaim an orphaned one.
func isOwnedMountPath(path string) bool {
	base := getVolumeMountBasePath()
	for _, prefix := range []string{
		filepath.Join(base, volumeMountPrefix),
		filepath.Join(base, filestoreMountPrefix),
	} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func (c *Client) unmountAndRemoveDir(ctx context.Context, path string) {
	mountBasePath := getVolumeMountBasePath()
	cleanPath := normalizeVolumePath(path)
	if !isOwnedMountPath(cleanPath) {
		return
	}

	mounted, probeErr := c.probeMounted(ctx, cleanPath)
	if probeErr != nil {
		// The reclaimer runs again; deleting a path we cannot prove is unmounted
		// would strand the mount under it.
		c.logger.WarnContext(ctx, "skipping volume reclaim, probe inconclusive", "path", cleanPath, "error", probeErr)
		return
	}
	if mounted {
		if err := c.umountPath(ctx, cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to unmount directory", "path", cleanPath, "error", err)
			return
		}
		if err := os.RemoveAll(cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to remove directory", "path", cleanPath, "error", err)
		}
		return
	}

	if c.isDirEmpty(ctx, cleanPath) {
		if err := os.Remove(cleanPath); err != nil {
			c.logger.ErrorContext(ctx, "failed to remove directory", "path", cleanPath, "error", err)
		}
		return
	}

	timestamp := time.Now().Unix()
	garbagePath := filepath.Join(mountBasePath, fmt.Sprintf("garbage-%d-%s", timestamp, strings.TrimPrefix(filepath.Base(cleanPath), volumeMountPrefix)))
	c.logger.DebugContext(ctx, "renaming non-empty volume directory", "path", garbagePath)
	if err := os.Rename(cleanPath, garbagePath); err != nil {
		c.logger.ErrorContext(ctx, "failed to rename directory", "path", cleanPath, "error", err)
	}
}

func (c *Client) isDirEmpty(ctx context.Context, path string) bool {
	entries, err := os.ReadDir(path)
	if err != nil {
		c.logger.ErrorContext(ctx, "failed to read directory", "path", path, "error", err)
		return false
	}
	return len(entries) == 0
}

func (c *Client) isRecentlyCreated(path string, exclusionPeriod time.Duration) bool {
	if exclusionPeriod <= 0 {
		return false
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < exclusionPeriod
}
