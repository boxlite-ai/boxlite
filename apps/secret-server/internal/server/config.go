package server

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Role, Environment, DatabaseURL, KeyID, Key, AuthMode, Audience, DevToken string
	AllowedCallers                                                           []string
	Port                                                                     string
	ShutdownTimeout                                                          time.Duration
}

func LoadConfig() (Config, error) {
	c := Config{Role: os.Getenv("SECRET_SERVER_ROLE"), Environment: os.Getenv("ENVIRONMENT"), DatabaseURL: os.Getenv("DATABASE_URL"), KeyID: os.Getenv("SECRET_MASTER_KEY_ID"), Key: os.Getenv("SECRET_MASTER_KEY_BASE64"), AuthMode: os.Getenv("SECRET_SERVER_AUTH_MODE"), Audience: os.Getenv("SECRET_SERVER_AUDIENCE"), DevToken: os.Getenv("SECRET_SERVER_DEV_TOKEN"), Port: os.Getenv("PORT")}
	if c.Port == "" {
		c.Port = "8080"
	}
	if _, err := net.LookupPort("tcp", c.Port); err != nil {
		return c, errors.New("invalid PORT")
	}
	seconds := os.Getenv("SHUTDOWN_TIMEOUT_SEC")
	if seconds == "" {
		seconds = "10"
	}
	n, err := strconv.Atoi(seconds)
	if err != nil || n < 1 || n > 3600 {
		return c, errors.New("invalid SHUTDOWN_TIMEOUT_SEC")
	}
	c.ShutdownTimeout = time.Duration(n) * time.Second
	for _, item := range strings.Split(os.Getenv("SECRET_SERVER_ALLOWED_CALLERS"), ",") {
		if item = strings.TrimSpace(item); item != "" {
			c.AllowedCallers = append(c.AllowedCallers, item)
		}
	}
	for name, value := range map[string]string{"DATABASE_URL": c.DatabaseURL, "SECRET_MASTER_KEY_ID": c.KeyID, "SECRET_MASTER_KEY_BASE64": c.Key} {
		if value == "" {
			return c, fmt.Errorf("missing %s", name)
		}
	}
	if c.Role != "write" && c.Role != "fetch" && c.Role != "all" {
		return c, errors.New("invalid SECRET_SERVER_ROLE")
	}
	if c.Environment != "local" && c.Environment != "dev" && c.Environment != "staging" && c.Environment != "production" {
		return c, errors.New("invalid ENVIRONMENT")
	}
	if c.Environment == "production" {
		return c, errors.New("SECRET_MASTER_KEY_BASE64 environment provider is not permitted for ENVIRONMENT production")
	}
	switch c.AuthMode {
	case "dev":
		if c.Environment != "local" && c.Environment != "dev" {
			return c, errors.New("SECRET_SERVER_AUTH_MODE dev is not permitted for ENVIRONMENT")
		}
		if c.DevToken == "" {
			return c, errors.New("missing SECRET_SERVER_DEV_TOKEN")
		}
	case "google":
		u, err := url.Parse(c.Audience)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return c, errors.New("invalid SECRET_SERVER_AUDIENCE")
		}
		if (c.Role == "write" || c.Role == "all") && len(c.AllowedCallers) == 0 {
			return c, errors.New("missing SECRET_SERVER_ALLOWED_CALLERS")
		}
	default:
		return c, errors.New("invalid SECRET_SERVER_AUTH_MODE")
	}
	return c, nil
}
