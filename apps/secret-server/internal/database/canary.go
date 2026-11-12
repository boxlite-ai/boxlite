package database

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var canaryContext = encryption.SecretContext{
	OrganizationID: "00000000-0000-0000-0000-000000000000",
	SecretID:       "00000000-0000-0000-0000-000000000000",
	Version:        1, Hosts: []string{"canary"}, Headers: map[string]string{"X-Canary": "canary"},
}

const canaryLock int64 = 0x626f786c69746501
const canaryValue = "boxlite secret server key verification v1"

// VerifyKey creates or checks durable ciphertext before the service is ready.
func VerifyKey(ctx context.Context, pool *pgxpool.Pool, cipher *encryption.Cipher) error {
	if cipher == nil {
		return errors.New("verify key: cipher is nil")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin key verification: %w", err)
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", canaryLock); err != nil {
		return fmt.Errorf("lock key verification: %w", err)
	}
	var envelope encryption.Envelope
	err = tx.QueryRow(ctx, "SELECT ciphertext, encrypted_dek, key_id FROM key_verification_canary WHERE id = 1").Scan(&envelope.Ciphertext, &envelope.WrappedDEK.Ciphertext, &envelope.WrappedDEK.KeyID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := verifyExistingVersion(ctx, tx, cipher); err != nil {
			return err
		}
		envelope, err = cipher.Encrypt(ctx, canaryContext, []byte(canaryValue))
		if err != nil {
			return fmt.Errorf("encrypt key canary: %w", err)
		}
		_, err = tx.Exec(ctx, "INSERT INTO key_verification_canary (id, ciphertext, encrypted_dek, key_id) VALUES (1, $1, $2, $3)", envelope.Ciphertext, envelope.WrappedDEK.Ciphertext, envelope.WrappedDEK.KeyID)
	}
	if err != nil {
		return fmt.Errorf("read or create key canary: %w", err)
	}
	plaintext, err := cipher.Decrypt(ctx, canaryContext, envelope)
	if err != nil {
		return fmt.Errorf("decrypt key canary: %w", err)
	}
	defer clear(plaintext)
	if !bytes.Equal(plaintext, []byte(canaryValue)) {
		return errors.New("key canary plaintext mismatch")
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit key verification: %w", err)
	}
	return nil
}

func verifyExistingVersion(ctx context.Context, tx pgx.Tx, cipher *encryption.Cipher) error {
	var identity encryption.SecretContext
	var headers []byte
	var envelope encryption.Envelope
	err := tx.QueryRow(ctx, `SELECT s.organization_id::text, v.secret_id::text, v.version, v.hosts, v.headers,
        v.ciphertext, v.encrypted_dek, v.key_id FROM secret_version v JOIN secret s ON s.id = v.secret_id LIMIT 1`).
		Scan(&identity.OrganizationID, &identity.SecretID, &identity.Version, &identity.Hosts, &headers, &envelope.Ciphertext, &envelope.WrappedDEK.Ciphertext, &envelope.WrappedDEK.KeyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read existing version for key verification: %w", err)
	}
	if err := json.Unmarshal(headers, &identity.Headers); err != nil {
		return fmt.Errorf("decode existing version headers: %w", err)
	}
	plaintext, err := cipher.Decrypt(ctx, identity, envelope)
	clear(plaintext)
	if err != nil {
		return fmt.Errorf("verify existing version key: %w", err)
	}
	return nil
}
