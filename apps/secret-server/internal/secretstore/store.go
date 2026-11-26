// Package secretstore stores encrypted secrets and retrieves metadata.
package secretstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrBoxOrgMismatch  = errors.New("box belongs to another organization")
	ErrBoxSecretsExist = errors.New("box already has secrets")
)

// The two-key advisory-lock namespace is distinct from one-key database locks.
const boxLockClass int32 = 0x42584c54

type Metadata struct {
	ID, OrganizationID, Scope     string
	BoxID                         *string
	Name, NormalizedName          string
	Hosts                         []string
	Headers                       map[string]string
	Placeholder, KeyID, CreatedBy string
	DisabledAt                    *time.Time
	CreatedAt                     time.Time
}

type Secret struct {
	Metadata Metadata
	Envelope encryption.Envelope
}

type Result struct {
	ID       string
	Inserted bool
}

// InsertBoxSecrets serializes a box transfer. The caller validates and encrypts
// first; checkExisting compares each stored secret before the transaction commits.
// A comparison error rolls back every insertion in the batch.
func InsertBoxSecrets(ctx context.Context, pool *pgxpool.Pool, orgID, boxID string, secrets []Secret, checkExisting func(context.Context, int, Secret) error) ([]Result, error) {
	if len(secrets) == 0 || checkExisting == nil {
		return nil, errors.New("empty transfer or missing retry check")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin transfer: %w", err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1, hashtext($2))", boxLockClass, boxID); err != nil {
		return nil, fmt.Errorf("lock box: %w", err)
	}
	rows, err := tx.Query(ctx, "SELECT organization_id <> $2::uuid, name_normalized FROM secret WHERE scope='box' AND box_id=$1", boxID, orgID)
	if err != nil {
		return nil, fmt.Errorf("read box secrets: %w", err)
	}
	names := make(map[string]bool)
	for rows.Next() {
		var otherOrg bool
		var name string
		if err = rows.Scan(&otherOrg, &name); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan box secrets: %w", err)
		}
		if otherOrg {
			rows.Close()
			return nil, ErrBoxOrgMismatch
		}
		names[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, fmt.Errorf("read box secrets: %w", err)
	}
	if len(names) > 0 {
		for _, s := range secrets {
			if !names[s.Metadata.NormalizedName] {
				return nil, ErrBoxSecretsExist
			}
		}
	}
	results := make([]Result, len(secrets))
	for i, s := range secrets {
		h, err := json.Marshal(s.Metadata.Headers)
		if err != nil {
			return nil, fmt.Errorf("encode headers: %w", err)
		}
		err = tx.QueryRow(ctx, `INSERT INTO secret (id,organization_id,scope,box_id,name,name_normalized,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by)
			VALUES ($1,$2,'box',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT (box_id,name_normalized) WHERE scope='box' DO NOTHING RETURNING id::text`,
			s.Metadata.ID, orgID, boxID, s.Metadata.Name, s.Metadata.NormalizedName, s.Envelope.Ciphertext, s.Envelope.WrappedDEK.Ciphertext, s.Envelope.WrappedDEK.KeyID, s.Metadata.Hosts, h, s.Metadata.Placeholder, s.Metadata.CreatedBy).Scan(&results[i].ID)
		if err == nil {
			results[i].Inserted = true
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("insert secret: %w", err)
		}
		existing, err := readExisting(ctx, tx, boxID, s.Metadata.NormalizedName)
		if err != nil {
			return nil, err
		}
		if err := checkExisting(ctx, i, existing); err != nil {
			return nil, err
		}
		results[i].ID = existing.Metadata.ID
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit transfer: %w", err)
	}
	return results, nil
}

func readExisting(ctx context.Context, tx pgx.Tx, boxID, name string) (Secret, error) {
	var s Secret
	var headers []byte
	err := tx.QueryRow(ctx, `SELECT id::text,organization_id::text,scope,box_id,name,name_normalized,hosts,headers,placeholder,key_id,created_by,disabled_at,created_at,ciphertext,encrypted_dek FROM secret WHERE scope='box' AND box_id=$1 AND name_normalized=$2`, boxID, name).Scan(&s.Metadata.ID, &s.Metadata.OrganizationID, &s.Metadata.Scope, &s.Metadata.BoxID, &s.Metadata.Name, &s.Metadata.NormalizedName, &s.Metadata.Hosts, &headers, &s.Metadata.Placeholder, &s.Metadata.KeyID, &s.Metadata.CreatedBy, &s.Metadata.DisabledAt, &s.Metadata.CreatedAt, &s.Envelope.Ciphertext, &s.Envelope.WrappedDEK.Ciphertext)
	if err != nil {
		return Secret{}, fmt.Errorf("read existing secret: %w", err)
	}
	if err = json.Unmarshal(headers, &s.Metadata.Headers); err != nil {
		return Secret{}, fmt.Errorf("decode headers: %w", err)
	}
	s.Envelope.WrappedDEK.KeyID = s.Metadata.KeyID
	return s, nil
}

// ReadMetadata returns pgx.ErrNoRows when the secret ID is absent.
func ReadMetadata(ctx context.Context, pool *pgxpool.Pool, id string) (Metadata, error) {
	var m Metadata
	var headers []byte
	err := pool.QueryRow(ctx, `SELECT id::text,organization_id::text,scope,box_id,name,name_normalized,hosts,headers,placeholder,key_id,created_by,disabled_at,created_at FROM secret WHERE id=$1`, id).Scan(&m.ID, &m.OrganizationID, &m.Scope, &m.BoxID, &m.Name, &m.NormalizedName, &m.Hosts, &headers, &m.Placeholder, &m.KeyID, &m.CreatedBy, &m.DisabledAt, &m.CreatedAt)
	if err != nil {
		return Metadata{}, err
	}
	if err = json.Unmarshal(headers, &m.Headers); err != nil {
		return Metadata{}, fmt.Errorf("decode headers: %w", err)
	}
	return m, nil
}
