package boxlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var ebsVolumeIDPattern = regexp.MustCompile(`^vol-[0-9a-f]+$`)

func (c *Client) ensureEBSVolumeMounted(
	ctx context.Context,
	boxID string,
	volumeID string,
	providerResourceID string,
	mountPath string,
) (retErr error) {
	if !ebsVolumeIDPattern.MatchString(providerResourceID) {
		return fmt.Errorf("invalid EBS provider resource id %q", providerResourceID)
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

	if err := claimEBSVolume(volumeID, boxID); err != nil {
		return err
	}
	defer func() {
		if retErr != nil {
			_ = releaseEBSVolumeClaim(volumeID, boxID)
		}
	}()

	if c.isDirectoryMounted(mountPath) {
		return nil
	}

	instanceID, err := ec2InstanceMetadata(ctx, "instance-id")
	if err != nil {
		return err
	}
	if err := runCommand(ctx, "aws", "ec2", "attach-volume",
		"--region", c.awsRegion,
		"--volume-id", providerResourceID,
		"--instance-id", instanceID,
		"--device", "/dev/sdf",
		"--output", "json",
	); err != nil {
		return fmt.Errorf("attach EBS volume %s: %w", providerResourceID, err)
	}

	device, err := waitForEBSDevice(ctx, providerResourceID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(mountPath, 0755); err != nil {
		return err
	}

	fsType, err := commandOutput(ctx, "blkid", "-o", "value", "-s", "TYPE", device)
	if err != nil && !isExitStatus(err, 2) {
		return fmt.Errorf("inspect EBS filesystem: %w", err)
	}
	if strings.TrimSpace(fsType) == "" {
		if err := runCommand(ctx, "mkfs.ext4", "-F", "-m", "0", device); err != nil {
			return fmt.Errorf("format EBS volume %s: %w", providerResourceID, err)
		}
	}
	if err := runCommand(ctx, "mount", "-o", "noatime", device, mountPath); err != nil {
		return fmt.Errorf("mount EBS volume %s: %w", providerResourceID, err)
	}
	return c.waitForMountReady(ctx, mountPath)
}

func (c *Client) releaseEBSVolume(
	ctx context.Context,
	boxID string,
	volumeID string,
	providerResourceID string,
	mountPath string,
) error {
	if !ebsVolumeIDPattern.MatchString(providerResourceID) {
		return fmt.Errorf("invalid EBS provider resource id %q", providerResourceID)
	}
	if c.isDirectoryMounted(mountPath) {
		if err := runCommand(ctx, "sync"); err != nil {
			return err
		}
		if err := runCommand(ctx, "umount", mountPath); err != nil {
			return fmt.Errorf("unmount EBS volume %s: %w", providerResourceID, err)
		}
	}
	if err := runCommand(ctx, "aws", "ec2", "detach-volume",
		"--region", c.awsRegion,
		"--volume-id", providerResourceID,
		"--output", "json",
	); err != nil {
		return fmt.Errorf("detach EBS volume %s: %w", providerResourceID, err)
	}
	if err := runCommand(ctx, "aws", "ec2", "wait", "volume-available",
		"--region", c.awsRegion,
		"--volume-ids", providerResourceID,
	); err != nil {
		return fmt.Errorf("wait for EBS volume %s detach: %w", providerResourceID, err)
	}
	return releaseEBSVolumeClaim(volumeID, boxID)
}

func claimEBSVolume(volumeID string, boxID string) error {
	if err := os.MkdirAll(getVolumeMountRecordDir(), 0755); err != nil {
		return err
	}
	path := filepath.Join(getVolumeMountRecordDir(), volumeID+".owner")
	data, err := os.ReadFile(path)
	if err == nil {
		if strings.TrimSpace(string(data)) == boxID {
			return nil
		}
		return fmt.Errorf("EBS volume %s is already owned by box %s", volumeID, strings.TrimSpace(string(data)))
	}
	if !os.IsNotExist(err) {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("EBS volume %s ownership changed concurrently", volumeID)
		}
		return err
	}
	defer file.Close()
	_, err = file.WriteString(boxID + "\n")
	return err
}

func releaseEBSVolumeClaim(volumeID string, boxID string) error {
	path := filepath.Join(getVolumeMountRecordDir(), volumeID+".owner")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(data)) != boxID {
		return fmt.Errorf("refusing to release EBS volume %s owned by another box", volumeID)
	}
	return os.Remove(path)
}

func ec2InstanceMetadata(ctx context.Context, key string) (string, error) {
	token, err := commandOutput(ctx, "curl", "-fsS", "-X", "PUT",
		"http://169.254.169.254/latest/api/token",
		"-H", "X-aws-ec2-metadata-token-ttl-seconds: 60",
	)
	if err != nil {
		return "", fmt.Errorf("get IMDSv2 token: %w", err)
	}
	value, err := commandOutput(ctx, "curl", "-fsS",
		"-H", "X-aws-ec2-metadata-token: "+strings.TrimSpace(token),
		"http://169.254.169.254/latest/meta-data/"+key,
	)
	if err != nil {
		return "", fmt.Errorf("get EC2 metadata %s: %w", key, err)
	}
	return strings.TrimSpace(value), nil
}

func waitForEBSDevice(ctx context.Context, providerResourceID string) (string, error) {
	serial := strings.ReplaceAll(providerResourceID, "-", "")
	for range 120 {
		out, err := commandOutput(ctx, "lsblk", "-ndo", "PATH,SERIAL")
		if err == nil {
			for _, line := range strings.Split(out, "\n") {
				fields := strings.Fields(line)
				if len(fields) == 2 && strings.EqualFold(fields[1], serial) {
					return fields[0], nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return "", fmt.Errorf("EBS device %s did not appear", providerResourceID)
}

func runCommand(ctx context.Context, name string, args ...string) error {
	_, err := commandOutput(ctx, name, args...)
	return err
}

func commandOutput(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func isExitStatus(err error, code int) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == code
}
