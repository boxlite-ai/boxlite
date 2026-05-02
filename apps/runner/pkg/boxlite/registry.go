// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import (
	"context"
	"fmt"
	"strings"

	"github.com/boxlite-labs/runner/pkg/api/dto"
	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

var linuxAmd64Platform = v1.Platform{OS: "linux", Architecture: "amd64"}

// PullSnapshot pulls a snapshot image and mirrors it to the destination registry when requested.
func (c *Client) PullSnapshot(ctx context.Context, req dto.PullSnapshotRequestDTO) error {
	c.logger.Info("pulling snapshot", "snapshot", req.Snapshot)

	if req.DestinationRegistry == nil {
		return c.PullImage(ctx, req.Snapshot)
	}

	if req.DestinationRegistry.Project == nil || strings.TrimSpace(*req.DestinationRegistry.Project) == "" {
		return fmt.Errorf("project is required when pushing to registry")
	}

	targetRef, err := c.getPullSnapshotTargetRef(ctx, req)
	if err != nil {
		return err
	}

	if err := c.copyRegistryImage(ctx, req.Snapshot, req.Registry, targetRef, req.DestinationRegistry); err != nil {
		return err
	}

	if err := c.PullImage(ctx, targetRef); err != nil {
		return fmt.Errorf("failed to pull copied snapshot %s into BoxLite cache: %w", targetRef, err)
	}

	return nil
}

// InspectImageInRegistry inspects an image in a remote registry.
func (c *Client) InspectImageInRegistry(ctx context.Context, imageName string, registry *dto.RegistryDTO) (*ImageDigest, error) {
	desc, err := c.getRegistryDescriptor(ctx, imageName, registry)
	if err != nil {
		return nil, err
	}

	totalSize, err := imageSizeFromDescriptor(desc)
	if err != nil {
		c.logger.WarnContext(ctx, "Failed to get image size from registry manifest", "imageName", imageName, "error", err)
		totalSize = desc.Size
		c.logger.WarnContext(ctx, "Falling back to descriptor size", "imageName", imageName, "size", totalSize)
	}

	if desc.Digest.String() == "" {
		return nil, fmt.Errorf("registry returned empty digest for image %s", imageName)
	}

	return &ImageDigest{
		Digest: desc.Digest.String(),
		Size:   totalSize,
	}, nil
}

func (c *Client) getPullSnapshotTargetRef(ctx context.Context, req dto.PullSnapshotRequestDTO) (string, error) {
	if req.DestinationRef != nil && strings.TrimSpace(*req.DestinationRef) != "" {
		return sanitizeImageReference(*req.DestinationRef), nil
	}

	digest, err := c.InspectImageInRegistry(ctx, req.Snapshot, req.Registry)
	if err != nil {
		return "", err
	}

	hash := strings.TrimPrefix(digest.Digest, "sha256:")
	if hash == "" {
		return "", fmt.Errorf("registry returned empty digest for image %s", req.Snapshot)
	}

	registryURL := sanitizeRegistryURL(req.DestinationRegistry.Url)
	return fmt.Sprintf("%s/%s/boxlite-%s:boxlite", registryURL, *req.DestinationRegistry.Project, hash), nil
}

func (c *Client) copyRegistryImage(
	ctx context.Context,
	sourceImage string,
	sourceRegistry *dto.RegistryDTO,
	targetImage string,
	targetRegistry *dto.RegistryDTO,
) error {
	desc, err := c.getRegistryDescriptor(ctx, sourceImage, sourceRegistry)
	if err != nil {
		return err
	}

	img, err := desc.Image()
	if err != nil {
		return fmt.Errorf("failed to resolve image from descriptor: %w", err)
	}

	targetRef, err := c.parseReference(targetImage, targetRegistry)
	if err != nil {
		return fmt.Errorf("failed to parse target image reference: %w", err)
	}

	if err := remote.Write(targetRef, img, c.remoteOptions(ctx, targetRegistry)...); err != nil {
		return fmt.Errorf("failed to push copied snapshot to registry: %w", err)
	}

	return nil
}

func (c *Client) getRegistryDescriptor(
	ctx context.Context,
	imageName string,
	registry *dto.RegistryDTO,
) (*remote.Descriptor, error) {
	ref, err := c.parseReference(imageName, registry)
	if err != nil {
		return nil, fmt.Errorf("failed to parse image reference: %w", err)
	}

	desc, err := remote.Get(ref, c.remoteOptions(ctx, registry)...)
	if err != nil {
		return nil, fmt.Errorf("failed to get image descriptor from registry: %w", err)
	}

	return desc, nil
}

func imageSizeFromDescriptor(desc *remote.Descriptor) (int64, error) {
	img, err := desc.Image()
	if err != nil {
		return 0, fmt.Errorf("failed to resolve image from descriptor: %w", err)
	}

	manifest, err := img.Manifest()
	if err != nil {
		return 0, fmt.Errorf("failed to get image manifest: %w", err)
	}

	var totalSize int64
	totalSize += manifest.Config.Size
	for _, layer := range manifest.Layers {
		totalSize += layer.Size
	}

	if totalSize == 0 {
		return 0, fmt.Errorf("manifest reported zero total size")
	}

	return totalSize, nil
}

func (c *Client) parseReference(imageName string, registry *dto.RegistryDTO) (name.Reference, error) {
	return name.ParseReference(sanitizeImageReference(imageName), c.nameOptions(registry)...)
}

func (c *Client) remoteOptions(ctx context.Context, registry *dto.RegistryDTO) []remote.Option {
	opts := []remote.Option{
		remote.WithContext(ctx),
		remote.WithPlatform(linuxAmd64Platform),
	}

	if registry != nil && registry.HasAuth() {
		opts = append(opts, remote.WithAuth(&authn.Basic{
			Username: *registry.Username,
			Password: *registry.Password,
		}))
	}

	return opts
}

func (c *Client) nameOptions(registry *dto.RegistryDTO) []name.Option {
	if c.isInsecureRegistry(registry) {
		return []name.Option{name.Insecure}
	}
	return nil
}

func (c *Client) isInsecureRegistry(registry *dto.RegistryDTO) bool {
	if registry == nil {
		return false
	}

	registryHost := registryHost(registry.Url)
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(registry.Url)), "http://") {
		return true
	}

	for _, insecureHost := range c.insecureRegistries {
		if registryHost == insecureHost {
			return true
		}
	}

	return false
}

func normalizeRegistryHosts(registries []string) []string {
	normalized := make([]string, 0, len(registries))
	for _, registry := range registries {
		host := registryHost(registry)
		if host != "" {
			normalized = append(normalized, host)
		}
	}
	return normalized
}

func registryHost(registryURL string) string {
	sanitized := sanitizeRegistryURL(registryURL)
	if sanitized == "" {
		return ""
	}
	return strings.SplitN(sanitized, "/", 2)[0]
}

func sanitizeRegistryURL(registryURL string) string {
	sanitized := strings.TrimSpace(registryURL)
	sanitized = strings.TrimPrefix(sanitized, "http://")
	sanitized = strings.TrimPrefix(sanitized, "https://")
	return strings.TrimRight(sanitized, "/")
}

func sanitizeImageReference(imageName string) string {
	return sanitizeRegistryURL(imageName)
}
