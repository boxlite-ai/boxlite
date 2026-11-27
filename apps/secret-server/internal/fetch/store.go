package fetch

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgxpool"
)

type secret struct {
	ID             string            `json:"id"`
	OrganizationID string            `json:"organization_id"`
	Scope          string            `json:"scope"`
	BoxID          *string           `json:"box_id"`
	Name           string            `json:"name"`
	Hosts          []string          `json:"hosts"`
	Headers        map[string]string `json:"headers"`
	Placeholder    string            `json:"placeholder"`
	DisabledAt     *string           `json:"disabled_at"`
	Ciphertext     string            `json:"ciphertext"`
	EncryptedDEK   string            `json:"encrypted_dek"`
	KeyID          string            `json:"key_id"`
}

type audit struct{ CredentialID, RunnerID, BoxID, SecretID, Result string }
type store interface {
	load(context.Context, []string) (map[string]secret, error)
	record(context.Context, ...audit) error
}
type postgres struct{ pool *pgxpool.Pool }

func (p postgres) load(ctx context.Context, ids []string) (map[string]secret, error) {
	// A 1 MiB write request fits after JSON reformatting and envelope hex encoding.
	// Bound the entire grant set before transferring any payload to the service.
	rows, err := p.pool.Query(ctx, `WITH checked AS MATERIALIZED (
 SELECT CASE WHEN octet_length(ciphertext)<=65565 AND octet_length(encrypted_dek)<=65536
 AND octet_length(row_to_json(s)::text)<=2097152 THEN row_to_json(s) END AS payload
 FROM secret s WHERE id=ANY($1::uuid[]))
 SELECT CASE WHEN count(payload) OVER () = count(*) OVER ()
 AND sum(octet_length(payload::text)) OVER ()<=12582912 THEN payload END FROM checked`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]secret, len(ids))
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		if len(data) == 0 {
			return nil, errors.New("stored secret exceeds size limit")
		}
		var s secret
		if err := json.Unmarshal(data, &s); err != nil {
			return nil, err
		}
		result[s.ID] = s
	}
	return result, rows.Err()
}
func (p postgres) record(ctx context.Context, entries ...audit) error {
	body, _ := json.Marshal(entries)
	_, err := p.pool.Exec(ctx, `INSERT INTO secret_access_log (credential_id,runner_id,box_id,secret_id,result)
 SELECT NULLIF(a->>'CredentialID','')::uuid,NULLIF(a->>'RunnerID',''),NULLIF(a->>'BoxID',''),
 NULLIF(a->>'SecretID','')::uuid,a->>'Result' FROM jsonb_array_elements($1::jsonb) a`, body)
	return err
}
func (s secret) envelope() (encryption.Envelope, error) {
	var e encryption.Envelope
	decode := func(s string) ([]byte, error) {
		if len(s) < 2 || s[:2] != `\x` {
			return nil, errors.New("invalid stored envelope")
		}
		return hex.DecodeString(s[2:])
	}
	var err error
	e.Ciphertext, err = decode(s.Ciphertext)
	if err != nil {
		return e, err
	}
	e.WrappedDEK.KeyID = s.KeyID
	e.WrappedDEK.Ciphertext, err = decode(s.EncryptedDEK)
	return e, err
}
