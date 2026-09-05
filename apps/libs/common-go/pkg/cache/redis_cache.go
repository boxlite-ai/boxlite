// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: Apache-2.0

package cache

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisConfig struct {
	Host     *string `envconfig:"HOST" mapstructure:"host"`
	Port     *int    `envconfig:"PORT" mapstructure:"port"`
	Username *string `envconfig:"USERNAME" mapstructure:"username"`
	Password *string `envconfig:"PASSWORD" mapstructure:"password"`
	TLS      *bool   `envconfig:"TLS" mapstructure:"tls"`
}

type RedisCache[T any] struct {
	redis     *redis.Client
	keyPrefix string
}

type ValueObject[T any] struct {
	Value T `json:"value"`
}

var client *redis.Client

func (c *RedisCache[T]) Set(ctx context.Context, key string, value T, expiration time.Duration) error {
	jsonValue, err := json.Marshal(ValueObject[T]{Value: value})
	if err != nil {
		return err
	}
	return c.redis.Set(ctx, c.keyPrefix+key, string(jsonValue), expiration).Err()
}

func (c *RedisCache[T]) Has(ctx context.Context, key string) (bool, error) {
	err := c.redis.Get(ctx, c.keyPrefix+key).Err()
	if err == nil {
		return true, nil
	}

	if err == redis.Nil {
		return false, nil
	}

	return false, err
}

func (c *RedisCache[T]) Get(ctx context.Context, key string) (*T, error) {
	value, err := c.redis.Get(ctx, c.keyPrefix+key).Result()
	if err != nil {
		return nil, err
	}
	var result ValueObject[T]
	err = json.Unmarshal([]byte(value), &result)
	if err != nil {
		return nil, err
	}
	return &result.Value, nil
}

func (c *RedisCache[T]) Delete(ctx context.Context, key string) error {
	return c.redis.Del(ctx, c.keyPrefix+key).Err()
}

// NetworkTunnelChecker checks whether a box has an active network-tunnel live
// lease in Redis. The lease key is set by the API's openNetworkTunnel endpoint
// and renewed by the CLI/SDK tunnel foreground loop; it expires automatically
// when the holder stops renewing (TTL set server-side).
type NetworkTunnelChecker struct {
	redis *redis.Client
}

// NewNetworkTunnelChecker returns a checker backed by the given Redis config.
// Returns nil, nil when config is nil (no Redis available), so callers can
// handle the no-Redis case without branching on error.
func NewNetworkTunnelChecker(config *RedisConfig) (*NetworkTunnelChecker, error) {
	if config == nil {
		return nil, nil
	}
	c, err := redisClient(config)
	if err != nil {
		return nil, err
	}
	return &NetworkTunnelChecker{redis: c}, nil
}

// IsLive reports whether boxId currently has an active tunnel lease.
// A Redis error is treated as "not live" (fail-closed).
func (c *NetworkTunnelChecker) IsLive(ctx context.Context, boxId string) bool {
	if c == nil {
		return false
	}
	n, err := c.redis.Exists(ctx, "box:network-tunnel-live:"+boxId).Result()
	return err == nil && n > 0
}

func redisClient(config *RedisConfig) (*redis.Client, error) {
	if config.Host == nil || config.Port == nil {
		return nil, errors.New("host and port are required")
	}
	// Reuse the module-level singleton when one is already initialised.
	if client != nil {
		return client, nil
	}
	username := ""
	if config.Username != nil {
		username = *config.Username
	}
	password := ""
	if config.Password != nil {
		password = *config.Password
	}
	options := &redis.Options{
		Addr:     fmt.Sprintf("%s:%d", *config.Host, *config.Port),
		Username: username,
		Password: password,
	}
	if config.TLS != nil && *config.TLS {
		options.TLSConfig = &tls.Config{}
	}
	client = redis.NewClient(options)
	return client, nil
}

func NewRedisCache[T any](config *RedisConfig, keyPrefix string) (*RedisCache[T], error) {
	c, err := redisClient(config)
	if err != nil {
		return nil, err
	}
	return &RedisCache[T]{
		redis:     c,
		keyPrefix: keyPrefix,
	}, nil
}
