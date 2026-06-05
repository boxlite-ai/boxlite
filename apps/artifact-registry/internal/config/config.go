/*
 * Copyright BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package config

import (
	"fmt"

	"github.com/kelseyhightower/envconfig"
)

// AuthType represents the authentication method for the registry
type AuthType string

const (
	AuthTypeNone  AuthType = "none"
	AuthTypeBasic AuthType = "basic"
)

type Config struct {
	Addr     string `envconfig:"ARTIFACT_REGISTRY_ADDR" default:":5000"`
	LogLevel string `envconfig:"ARTIFACT_REGISTRY_LOG_LEVEL" default:"info"`

	// Storage configuration
	StorageDriver       string `envconfig:"ARTIFACT_REGISTRY_STORAGE_DRIVER" default:"filesystem"`
	StorageDir          string `envconfig:"ARTIFACT_REGISTRY_STORAGE_DIR" default:"./data"`
	StorageDeleteEnable bool   `envconfig:"ARTIFACT_REGISTRY_STORAGE_DELETE_ENABLED" default:"false"`

	// Cache configuration
	CacheEnabled bool   `envconfig:"ARTIFACT_REGISTRY_CACHE_ENABLED" default:"true"`
	CacheDriver  string `envconfig:"ARTIFACT_REGISTRY_CACHE_DRIVER" default:"inmemory"`

	// S3 storage configuration
	S3Region         string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_REGION"`
	S3Bucket         string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_BUCKET"`
	S3AccessKey      string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_ACCESSKEY"`
	S3SecretKey      string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_SECRETKEY"`
	S3RegionEndpoint string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_REGIONENDPOINT"`
	S3Encrypt        bool   `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_ENCRYPT" default:"false"`
	S3Secure         bool   `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_SECURE" default:"true"`
	S3RootDirectory  string `envconfig:"ARTIFACT_REGISTRY_STORAGE_S3_ROOTDIRECTORY"`

	// TLS configuration
	TLSCertificate string `envconfig:"ARTIFACT_REGISTRY_HTTP_TLS_CERTIFICATE"`
	TLSKey         string `envconfig:"ARTIFACT_REGISTRY_HTTP_TLS_KEY"`

	// Authentication
	AuthType         AuthType `envconfig:"ARTIFACT_REGISTRY_AUTH_TYPE" default:"none"`
	AuthUsername     string   `envconfig:"ARTIFACT_REGISTRY_AUTH_USERNAME"`
	AuthPassword     string   `envconfig:"ARTIFACT_REGISTRY_AUTH_PASSWORD"`
	AuthHtpasswdPath string   `envconfig:"ARTIFACT_REGISTRY_AUTH_HTPASSWD_PATH"`

	// HTTP secret for multi-instance deployments
	HTTPSecret string `envconfig:"ARTIFACT_REGISTRY_HTTP_SECRET"`
}

func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("failed to process env config: %w", err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

func (c *Config) Validate() error {
	switch c.StorageDriver {
	case "filesystem":
		// filesystem is valid with defaults
	case "s3":
		if c.S3Region == "" || c.S3Bucket == "" {
			return fmt.Errorf("S3 storage requires ARTIFACT_REGISTRY_STORAGE_S3_REGION and ARTIFACT_REGISTRY_STORAGE_S3_BUCKET")
		}
	default:
		return fmt.Errorf("unsupported storage driver: %s", c.StorageDriver)
	}

	if c.TLSCertificate != "" && c.TLSKey == "" {
		return fmt.Errorf("ARTIFACT_REGISTRY_HTTP_TLS_KEY is required when ARTIFACT_REGISTRY_HTTP_TLS_CERTIFICATE is set")
	}

	if err := c.validateAuth(); err != nil {
		return err
	}

	return nil
}

func (c *Config) validateAuth() error {
	switch c.AuthType {
	case AuthTypeNone:
		// No authentication required
	case AuthTypeBasic:
		if c.AuthUsername == "" || c.AuthPassword == "" {
			return fmt.Errorf("ARTIFACT_REGISTRY_AUTH_USERNAME and ARTIFACT_REGISTRY_AUTH_PASSWORD are required when ARTIFACT_REGISTRY_AUTH_TYPE is 'basic'")
		}
	default:
		return fmt.Errorf("unsupported auth type: %s (supported: none, basic)", c.AuthType)
	}
	return nil
}
