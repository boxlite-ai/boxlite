package boxlite

import (
	"context"
	"encoding/json"
	"errors"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/containerd/errdefs"
)

var errProtectedBox = errors.New("protected Box requires coordinated recovery or removal")

// ProtectedBoot shares the admission lease with creation and removal. Runtime
// then acquires the lifecycle lock before admitting or retiring the attempt.
func (c *Client) ProtectedBoot(ctx context.Context, boxID string, operation boxlite.ProtectedBootOperation, payload any) (json.RawMessage, error) {
	lease, err := c.checkpointOperations().Lock(ctx, boxID)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	if err := lease.CheckIdle(); err != nil {
		return nil, err
	}
	box, err := c.getOrFetchBox(ctx, boxID)
	if err != nil {
		return nil, err
	}
	return box.RunnerProtectedBoot(ctx, operation, payload)
}

func (c *Client) refuseProtectedRemoval(ctx context.Context, ids []string) error {
	for _, id := range ids {
		box, err := c.runtime.Get(ctx, id)
		if boxlite.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		protected, err := box.HasRunnerProtection(ctx)
		box.Close()
		if err != nil {
			return err
		}
		if protected {
			return errors.Join(errdefs.ErrFailedPrecondition, errProtectedBox)
		}
	}
	return nil
}
