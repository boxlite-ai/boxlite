package boxlite

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	socketSymlinkBase = "/tmp"
	controlSocketName = "gvproxy-ctl.sock"
	gvproxyGuestIP    = "192.168.127.2" // Mirrors src/boxlite/src/net/constants.rs::GUEST_IP.
)

// GvproxyServicesEndpoint returns the Unix socket endpoint used by
// gvproxy's internal ServicesMux tunnel. The public/control-plane box id may be
// the box name, so resolve the box first and then use the core runtime id in the
// Rust socket path.
func (c *Client) GvproxyServicesEndpoint(ctx context.Context, boxId string) (string, string, error) {
	if err := validateBoxIdForSocketPath(boxId); err != nil {
		return "", "", err
	}

	bx, err := c.getOrFetchBox(ctx, boxId)
	if err != nil {
		return "", "", err
	}

	socketPath, err := gvproxyServicesSocketPathForRuntimeBoxID(bx.ID())
	if err != nil {
		return "", "", err
	}

	return socketPath, gvproxyGuestIP, nil
}

func gvproxyServicesSocketPathForRuntimeBoxID(runtimeBoxID string) (string, error) {
	if err := validateBoxIdForSocketPath(runtimeBoxID); err != nil {
		return "", err
	}

	return filepath.Join(socketSymlinkBase, fmt.Sprintf("bl-%d", os.Getuid()), runtimeBoxID, controlSocketName), nil
}

func validateBoxIdForSocketPath(boxId string) error {
	if boxId == "" {
		return fmt.Errorf("box id is required")
	}
	if boxId == "." || boxId == ".." || strings.ContainsAny(boxId, `/\`) {
		return fmt.Errorf("invalid box id %q", boxId)
	}
	return nil
}
