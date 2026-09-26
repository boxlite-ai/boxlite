// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package secrets reads the passwords organizations registered for private
// registries.
//
// Reading is all it does. The API writes these passwords and cannot read them
// back; this process reads them and holds no permission to write, so a
// compromised proxy cannot quietly swap one.
package secrets

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"golang.org/x/oauth2/google"
)

// ErrInvalidVersion means the control plane named a version this package will
// not turn into a URL or a path.
var ErrInvalidVersion = errors.New("invalid secret version")

// Reader returns the password held in one secret version.
type Reader interface {
	Read(ctx context.Context, version string) (string, error)
}

// NewReader returns the reader store names: "gcp" for Secret Manager, "file"
// for a directory on a local stack. An empty store returns nil, which leaves
// private registries off and every pull anonymous.
func NewReader(ctx context.Context, store, directory string) (Reader, error) {
	switch store {
	case "":
		return nil, nil
	case "gcp":
		return newSecretManager(ctx)
	case "file":
		return fileReader{directory: directory}, nil
	default:
		return nil, fmt.Errorf("secret store must be \"gcp\" or \"file\", got %q", store)
	}
}

// secretManagerVersion is the one shape the API records: a numbered version of
// a secret in a project. Anything else is refused before it reaches a URL.
var secretManagerVersion = regexp.MustCompile(`^projects/[a-z0-9-]+/secrets/[A-Za-z0-9_-]+/versions/[0-9]+$`)

// secretManagerTimeout bounds one read. The read sits inside a pull that is
// waiting on it, and Secret Manager answers in milliseconds when it answers.
const secretManagerTimeout = 10 * time.Second

// payloadLimit caps the response. A registry password is a few hundred bytes
// at most; a GCP service account key, the largest thing one of these holds, is
// a few kilobytes.
const payloadLimit = 64 << 10

const secretManagerEndpoint = "https://secretmanager.googleapis.com/v1/"

type secretManager struct {
	client   *http.Client
	endpoint string
}

func newSecretManager(ctx context.Context) (*secretManager, error) {
	// Application Default Credentials: the service account Cloud Run attaches,
	// or a developer's gcloud login. The client refreshes its own token.
	client, err := google.DefaultClient(ctx, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return nil, fmt.Errorf("find credentials for Secret Manager: %w", err)
	}
	client.Timeout = secretManagerTimeout
	return &secretManager{client: client, endpoint: secretManagerEndpoint}, nil
}

func (s *secretManager) Read(ctx context.Context, version string) (string, error) {
	if !secretManagerVersion.MatchString(version) {
		return "", fmt.Errorf("%w: %q", ErrInvalidVersion, version)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint+version+":access", nil)
	if err != nil {
		return "", fmt.Errorf("build a read of %s: %w", version, err)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", version, err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("read %s: Secret Manager answered %s", version, response.Status)
	}
	var accessed struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, payloadLimit)).Decode(&accessed); err != nil {
		return "", fmt.Errorf("read %s: the answer is not a secret payload: %w", version, err)
	}
	password, err := base64.StdEncoding.DecodeString(accessed.Payload.Data)
	if err != nil {
		return "", fmt.Errorf("read %s: the payload is not base64: %w", version, err)
	}
	return string(password), nil
}

// fileVersion is what the API's file store names a version: a bare file name,
// so a version cannot climb out of the directory.
var fileVersion = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type fileReader struct {
	directory string
}

func (f fileReader) Read(_ context.Context, version string) (string, error) {
	if !fileVersion.MatchString(version) {
		return "", fmt.Errorf("%w: %q", ErrInvalidVersion, version)
	}
	password, err := os.ReadFile(filepath.Join(f.directory, version))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", version, err)
	}
	return string(password), nil
}
