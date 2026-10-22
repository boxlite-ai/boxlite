package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

var cacheName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var cacheTenant = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// CacheInfo deliberately contains no runner paths. A stopped Box still owns its
// cache, since it may restart without another create request.
type CacheInfo struct {
	Type      string    `json:"type"`
	ID        string    `json:"id"`
	BoxID     string    `json:"box_id,omitempty"`
	InUse     bool      `json:"in_use"`
	IdleSince time.Time `json:"idle_since"`
}

func cacheError(code sdk.ErrorCode, message string) error {
	return &sdk.Error{Code: code, Message: message}
}

func privateDirectory(path string, create bool) error {
	if create {
		if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
			return err
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("cache storage component is not a directory")
	}
	return nil
}

func (c *Client) cachePath(tenant, id string, create bool) (string, error) {
	if !cacheTenant.MatchString(tenant) || !cacheName.MatchString(id) {
		return "", cacheError(sdk.ErrInvalidArgument, "invalid cache tenant or ID")
	}
	root := filepath.Join(c.homeDir, "cache-volumes")
	path := root
	for _, part := range []string{"", tenant, id} {
		if part != "" {
			path = filepath.Join(path, part)
		}
		if err := privateDirectory(path, create); err != nil {
			if os.IsNotExist(err) {
				return "", cacheError(sdk.ErrNotFound, "cache not found")
			}
			return "", err
		}
	}
	return path, nil
}

func writeCache(path string, info *CacheInfo) error {
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(path, ".lease-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), filepath.Join(path, "lease.json"))
}

// Never infer absence from a timeout, failed state or a stopped VM. The native
// catalog must explicitly report NotFound before a crashed admission is reclaimed.
func (c *Client) readCache(ctx context.Context, path, id string) (*CacheInfo, error) {
	data, err := os.ReadFile(filepath.Join(path, "lease.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return &CacheInfo{Type: "cache", ID: id, IdleSince: time.Now().UTC()}, nil
		}
		return nil, err
	}
	var info CacheInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	if info.ID != id || info.Type != "cache" {
		return nil, fmt.Errorf("invalid cache metadata")
	}
	if info.BoxID != "" {
		_, err := c.runtime.Get(ctx, info.BoxID)
		var native *sdk.Error
		if errors.As(err, &native) && native.Code == sdk.ErrNotFound {
			info.BoxID, info.InUse, info.IdleSince = "", false, time.Now().UTC()
			if err := writeCache(path, &info); err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		} else {
			info.InUse = true
		}
	}
	return &info, nil
}

// Caller holds cacheMu through native create, preventing another request from
// mistaking an in-progress admission for a crashed admission with no Box yet.
func (c *Client) acquireCaches(ctx context.Context, box dto.CreateBoxDTO) ([]volumeMount, error) {
	var mounts []volumeMount
	seen := map[string]bool{}
	for _, volume := range box.Volumes {
		if volume.Type != "cache" {
			continue
		}
		if box.OrganizationId == nil || volume.Subpath != nil || seen[volume.VolumeId] {
			return nil, cacheError(sdk.ErrInvalidArgument, "cache requires tenant, unique ID and no subpath")
		}
		seen[volume.VolumeId] = true
		path, err := c.cachePath(*box.OrganizationId, volume.VolumeId, true)
		if err != nil {
			return nil, err
		}
		info, err := c.readCache(ctx, path, volume.VolumeId)
		if err != nil {
			return nil, err
		}
		if info.InUse && info.BoxID != box.Id {
			return nil, cacheError(sdk.ErrInvalidState, "cache is exclusively owned by another Box")
		}
		data := filepath.Join(path, "data")
		if err := privateDirectory(data, true); err != nil {
			return nil, err
		}
		info.BoxID, info.InUse = box.Id, true
		if err := writeCache(path, info); err != nil {
			return nil, err
		}
		mounts = append(mounts, volumeMount{hostPath: data, mountPath: volume.MountPath})
	}
	return mounts, nil
}

func (c *Client) CacheGet(ctx context.Context, tenant, id string) (*CacheInfo, error) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	path, err := c.cachePath(tenant, id, false)
	if err != nil {
		return nil, err
	}
	return c.readCache(ctx, path, id)
}

// Collection is explicit, never pressure-triggered. An optional cutoff lets an
// operator delete only caches that have been observed idle since before it.
func (c *Client) CacheRemove(ctx context.Context, tenant, id string, idleBefore *time.Time) error {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	path, err := c.cachePath(tenant, id, false)
	if err != nil {
		return err
	}
	info, err := c.readCache(ctx, path, id)
	if err != nil {
		return err
	}
	if info.InUse {
		return cacheError(sdk.ErrInvalidState, "cache is in use")
	}
	if idleBefore != nil && !info.IdleSince.Before(*idleBefore) {
		return cacheError(sdk.ErrInvalidState, "cache has not reached the requested idle age")
	}
	return os.RemoveAll(path)
}
