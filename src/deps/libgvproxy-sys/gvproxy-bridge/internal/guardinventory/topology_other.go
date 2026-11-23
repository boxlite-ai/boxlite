//go:build !linux

package guardinventory

import (
	"context"
	"fmt"
)

func AppliedTopology(context.Context) (string, error) {
	return "", fmt.Errorf("applied Cloud topology requires Linux")
}
