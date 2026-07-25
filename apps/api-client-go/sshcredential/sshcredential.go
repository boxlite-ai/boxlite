/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Package sshcredential is a hand-written companion to the generated
// api-client-go Hosted API client. It lives in its own subdirectory (not
// alongside the generated *.go files) because the client's regeneration
// target runs `rm -f {projectRoot}/*.go` before invoking the generator --
// a top-level hand-written file would be silently destroyed on the next
// regen. It calls only the Hosted API's public BoxAccessGrant/SshAccess
// endpoints and never the Runner-facing internal control facade
// (boxlite Go SDK's `Box.SSH()`), per the design's explicit separation.
package sshcredential

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"fmt"
	"strings"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"golang.org/x/crypto/ssh"
)

// Credential is a newly created temporary SSH credential. PrivateKeyPEM is
// generated locally and never transmitted to the API; it exists only in
// this struct and is the caller's sole copy -- store it now, since the
// server has no way to return it again.
type Credential struct {
	*apiclient.TemporarySshCredentialCreated
	PrivateKeyPEM string
}

// CreateOption customizes CreateEphemeralCredential.
type CreateOption func(*createOptions)

type createOptions struct {
	appKey         string
	organizationID string
	comment        string
}

// WithAppKey authenticates the create call via the box-scoped app key
// issued by a prior access-grant create call, instead of the caller's
// normal account authorization (set via context.Context per the generated
// client's ContextAccessToken convention). The API rejects a request that
// supplies both.
func WithAppKey(appKey string) CreateOption {
	return func(o *createOptions) { o.appKey = appKey }
}

// WithOrganizationID sets the X-BoxLite-Organization-ID header for
// account-authenticated (JWT) calls.
func WithOrganizationID(organizationID string) CreateOption {
	return func(o *createOptions) { o.organizationID = organizationID }
}

// WithComment sets the comment suffix on the generated public key line
// (default "boxlite-sdk").
func WithComment(comment string) CreateOption {
	return func(o *createOptions) { o.comment = comment }
}

// CreateEphemeralCredential generates an ephemeral Ed25519 keypair locally,
// submits only the public key to create a temporary SSH credential scoped
// to grantID, and returns the credential together with the private key.
// The private key never leaves this process except in the returned struct.
func CreateEphemeralCredential(
	ctx context.Context,
	client *apiclient.APIClient,
	boxIdOrName string,
	grantID string,
	ttl time.Duration,
	opts ...CreateOption,
) (*Credential, error) {
	options := createOptions{comment: "boxlite-sdk"}
	for _, opt := range opts {
		opt(&options)
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ed25519 keypair: %w", err)
	}

	sshPublicKey, err := ssh.NewPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("convert ed25519 public key to SSH format: %w", err)
	}
	publicKeyLine := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPublicKey))) + " " + options.comment

	privateKeyBlock, err := ssh.MarshalPrivateKey(privateKey, options.comment)
	if err != nil {
		return nil, fmt.Errorf("marshal ed25519 private key: %w", err)
	}
	privateKeyPEM := string(pem.EncodeToMemory(privateKeyBlock))

	req := client.SshAccessAPI.CreateTemporarySshCredential(ctx, boxIdOrName).
		CreateTemporarySshCredential(apiclient.CreateTemporarySshCredential{
			GrantId:          grantID,
			PublicKey:        publicKeyLine,
			ExpiresInSeconds: apiclient.PtrFloat32(float32(ttl.Seconds())),
		})
	if options.appKey != "" {
		req = req.XBoxLiteAppKey(options.appKey)
	}
	if options.organizationID != "" {
		req = req.XBoxLiteOrganizationID(options.organizationID)
	}

	created, _, err := req.Execute()
	if err != nil {
		return nil, fmt.Errorf("create temporary SSH credential for box %s: %w", boxIdOrName, err)
	}

	return &Credential{TemporarySshCredentialCreated: created, PrivateKeyPEM: privateKeyPEM}, nil
}
