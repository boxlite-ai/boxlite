// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025 Daytona Platforms Inc.
// Modified and rebranded for BoxLite

package boxlite

import "strings"

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
