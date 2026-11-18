// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestS3ArchiveUsesRoleCredentials(t *testing.T) {
	for _, key := range []string{
		"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
		"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN",
	} {
		t.Setenv(key, "")
	}
	metadata := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"AccessKeyId": "ROLE_ACCESS_KEY", "SecretAccessKey": "role-secret",
			"Token": "role-session-token", "Expiration": time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
		})
	}))
	defer metadata.Close()
	t.Setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", metadata.URL)

	type request struct{ authorization, token, path string }
	requests := make(chan request, 1)
	objects := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- request{r.Header.Get("Authorization"), r.Header.Get("X-Amz-Security-Token"), r.URL.Path}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer objects.Close()
	store, err := NewS3ArchiveStore(S3ArchiveStoreConfig{
		EndpointUrl: objects.URL, Region: "us-east-1", Bucket: "archives",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := store.Remove(ctx, "s3://archives/checkpoints/org/checkpoint/archive.boxlite"); err != nil {
		t.Fatal(err)
	}
	observed := <-requests
	if !strings.Contains(observed.authorization, "Credential=ROLE_ACCESS_KEY/") {
		t.Fatalf("archive deletion did not use role credentials: Authorization=%q", observed.authorization)
	}
	if observed.token != "role-session-token" {
		t.Fatalf("temporary role session token was omitted: got %q", observed.token)
	}
	if observed.path != "/archives/checkpoints/org/checkpoint/archive.boxlite" {
		t.Fatalf("deletion addressed the wrong object: %q", observed.path)
	}
}

func TestS3ArchiveRejectsPartialCredentials(t *testing.T) {
	for _, cfg := range []S3ArchiveStoreConfig{
		{Region: "us-east-1", Bucket: "archives", AccessKeyId: "key"},
		{Region: "us-east-1", Bucket: "archives", SecretAccessKey: "secret"},
	} {
		if _, err := NewS3ArchiveStore(cfg); err == nil || !strings.Contains(err.Error(), "supplied together") {
			t.Fatalf("partial credentials were not rejected: %v", err)
		}
	}
}
