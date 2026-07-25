package boxlite

import (
	"context"
	"fmt"

	boxlitesdk "github.com/boxlite-ai/boxlite/sdks/go"
)

// ReplaceSshAccessSet applies a full-set replace of boxID's SSH access
// snapshot via the typed BoxLite Runtime facade (Box.SSH()), never a
// hand-built guest path or control stream. SSH bytes themselves stay on the
// existing Network().Tunnel() data path -- this is control plane only.
func (c *Client) ReplaceSshAccessSet(
	ctx context.Context,
	boxID string,
	generation uint64,
	accesses []boxlitesdk.SshAccessEntry,
) (*boxlitesdk.SshStatus, error) {
	bx, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}

	ssh, err := bx.SSH()
	if err != nil {
		return nil, fmt.Errorf("open box ssh handle for %s: %w", boxID, err)
	}
	defer ssh.Close()

	status, err := ssh.ReplaceAccessSet(ctx, generation, accesses)
	if err != nil {
		return nil, fmt.Errorf("apply ssh access set for %s: %w", boxID, err)
	}
	return status, nil
}
