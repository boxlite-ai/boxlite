package boxlite

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
)

var efsAccessPointIDPattern = regexp.MustCompile(`^fsap-[0-9a-f]{8,40}$`)
var efsFileSystemIDPattern = regexp.MustCompile(`^fs-[0-9a-f]{8,40}$`)

func (c *Client) ensureEFSVolumeMounted(
	ctx context.Context,
	volumeID string,
	accessPointID string,
	mountPath string,
) error {
	if !efsFileSystemIDPattern.MatchString(c.efsFileSystemID) {
		return fmt.Errorf("invalid or missing EFS file system id %q", c.efsFileSystemID)
	}
	if !efsAccessPointIDPattern.MatchString(accessPointID) {
		return fmt.Errorf("invalid EFS access point id %q", accessPointID)
	}

	c.volumeMutexesMutex.Lock()
	volumeMutex, exists := c.volumeMutexes[volumeID]
	if !exists {
		volumeMutex = new(sync.Mutex)
		c.volumeMutexes[volumeID] = volumeMutex
	}
	c.volumeMutexesMutex.Unlock()

	volumeMutex.Lock()
	defer volumeMutex.Unlock()

	if c.isDirectoryMounted(mountPath) {
		return nil
	}
	if err := os.MkdirAll(mountPath, 0755); err != nil {
		return fmt.Errorf("create EFS mount directory: %w", err)
	}
	if err := runCommand(ctx, "mount", efsMountArgs(c.efsFileSystemID, accessPointID, mountPath)...); err != nil {
		return fmt.Errorf("mount EFS volume %s: %w", volumeID, err)
	}
	return c.waitForMountReady(ctx, mountPath)
}

func efsMountArgs(fileSystemID string, accessPointID string, mountPath string) []string {
	return []string{
		"-t", "efs",
		"-o", "tls,accesspoint=" + accessPointID,
		fileSystemID + ":/",
		mountPath,
	}
}

func runCommand(ctx context.Context, name string, args ...string) error {
	_, err := commandOutput(ctx, name, args...)
	return err
}

func commandOutput(ctx context.Context, name string, args ...string) (string, error) {
	out, err := execCommandContext(ctx, name, args...)
	if err != nil {
		return "", fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

var execCommandContext = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}
