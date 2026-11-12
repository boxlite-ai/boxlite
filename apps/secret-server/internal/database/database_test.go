package database

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pressly/goose/v3/lock"
)

func TestNormalizeName(t *testing.T) {
	for _, tc := range []struct {
		input, want string
		valid       bool
	}{
		{"open-ai", "OPEN_AI", true}, {"café", "CAF_", true}, {"", "", false},
		{strings.Repeat("a", 64), strings.Repeat("A", 64), true}, {strings.Repeat("a", 65), "", false},
		{"\xff", "", false}, {"a\x00b", "", false},
	} {
		got, err := NormalizeName(tc.input)
		if (err == nil) != tc.valid || got != tc.want {
			t.Errorf("NormalizeName(%q) = %q, %v", tc.input, got, err)
		}
	}
}

func TestIntegration(t *testing.T) {
	url := os.Getenv("SECRET_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set SECRET_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var nonce [8]byte
	rand.Read(nonce[:])
	name := fmt.Sprintf("secret_test_%x", nonce)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	}()
	config.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	held, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := held.Exec(ctx, `SELECT pg_advisory_lock($1)`, lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	blocked, stop := context.WithTimeout(ctx, 300*time.Millisecond)
	err = Migrate(blocked, pool)
	stop()
	if err == nil {
		t.Error("migration succeeded while lock was held")
	}
	if _, err := held.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lock.DefaultLockID); err != nil {
		t.Fatal(err)
	}
	held.Release()
	if _, err := pool.Exec(ctx, `CREATE TABLE secret (id integer)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err == nil {
		t.Fatal("migration unexpectedly succeeded with a conflicting table")
	}
	if _, err := pool.Exec(ctx, `DROP TABLE secret`); err != nil {
		t.Fatal(err)
	}

	databaseURL, err := testDatabaseURL(url, name)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var processes [2]*exec.Cmd
	for i := range processes {
		processes[i] = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMigrationProcess$")
		processes[i].Env = append(os.Environ(), "SECRET_MIGRATION_PROCESS_URL="+databaseURL)
		if err := processes[i].Start(); err != nil {
			t.Fatal(err)
		}
	}
	for _, process := range processes {
		if err := process.Wait(); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO goose_db_version (version_id, is_applied) VALUES (2, true)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatalf("older binary with newer schema: %v", err)
	}

	cipher := testCipher(t, 1)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs2 := VerifyKey(ctx, pool, cipher)
			if errs2 != nil {
				t.Error(errs2)
			}
		}()
	}
	wg.Wait()
	if err := VerifyKey(ctx, pool, testCipher(t, 2)); err == nil {
		t.Error("different key accepted")
	}
	if _, err := pool.Exec(ctx, "UPDATE key_verification_canary SET ciphertext = decode('00','hex')"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyKey(ctx, pool, cipher); err == nil {
		t.Error("corrupt canary accepted")
	}
	if _, err := pool.Exec(ctx, "DELETE FROM key_verification_canary"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyKey(ctx, pool, cipher); err != nil {
		t.Fatal(err)
	}

	org := "10000000-0000-0000-0000-000000000001"
	id := "20000000-0000-0000-0000-000000000001"
	identity := encryption.SecretContext{OrganizationID: org, SecretID: id, Version: 1, Hosts: []string{"host"}, Headers: map[string]string{"Authorization": "Bearer {value}"}}
	envelope, err := cipher.Encrypt(ctx, identity, []byte("test secret"))
	if err != nil {
		t.Fatal(err)
	}
	normalized, err := NormalizeName("open-ai")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO secret(id, organization_id, scope, name, name_normalized, current_version, created_by) VALUES ($1,$2,'org','open-ai',$3,1,'test')`, id, org, normalized)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,1,$2,$3,$4,ARRAY['host'],'{"Authorization":"Bearer {value}"}','p','test')`, id, envelope.Ciphertext, envelope.WrappedDEK.Ciphertext, envelope.WrappedDEK.KeyID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,2,'x','y','env:key',ARRAY[]::text[],'{"A":"b"}','p','test')`,
		`INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,2,'x','y','env:key',ARRAY['host'],'{}','p','test')`,
		`INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,2,'x','y','env:key',ARRAY['host'],'[]','p','test')`,
		`INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,2,'x','y','env:key',ARRAY['host'],'{"A":"b"}','','test')`,
	} {
		if _, err := pool.Exec(ctx, statement, id); err == nil {
			t.Errorf("invalid version accepted: %s", statement)
		}
	}
	if _, err := pool.Exec(ctx, "DELETE FROM key_verification_canary"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyKey(ctx, pool, testCipher(t, 2)); err == nil {
		t.Error("wrong key recreated canary despite existing version")
	}
	if err := VerifyKey(ctx, pool, cipher); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE secret_version SET hosts=ARRAY['other'] WHERE secret_id=$1`, id); err == nil {
		t.Error("mutable hosts accepted")
	}
	if _, err := pool.Exec(ctx, `UPDATE secret_version SET encrypted_dek='new', key_id='env:new' WHERE secret_id=$1`, id); err != nil {
		t.Error(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO secret(organization_id,scope,name,name_normalized,current_version,created_by) VALUES ($1,'org','open_ai',$2,1,'test')`, org, normalized); err == nil {
		t.Error("duplicate normalized name accepted")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO secret(organization_id,scope,name,name_normalized,current_version,created_by) VALUES ($1,'org','abc','OTHER',1,'test')`, org); err == nil {
		t.Error("incorrect normalization accepted")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO secret(organization_id,scope,name,name_normalized,current_version,created_by) VALUES ($1,'org','missing','MISSING',1,'test')`, org); err == nil {
		t.Error("missing current version accepted")
	}
	if _, err := pool.Exec(ctx, `DELETE FROM secret WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM secret_version WHERE secret_id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Errorf("cascade count %d: %v", count, err)
	}
	for i, box := range []string{"box-a", "box-b"} {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		boxID := fmt.Sprintf("20000000-0000-0000-0000-%012d", i+2)
		boxName, err := NormalizeName("café")
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO secret(id,organization_id,scope,box_id,name,name_normalized,current_version,created_by) VALUES ($1,$2,'box',$3,'café',$4,1,'test')`, boxID, org, box, boxName)
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(ctx, `INSERT INTO secret_version(secret_id,version,ciphertext,encrypted_dek,key_id,hosts,headers,placeholder,created_by) VALUES ($1,1,'x','y','env:key',ARRAY['host'],'{"A":"b"}','p','test')`, boxID)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func testCipher(t *testing.T, key byte) *encryption.Cipher {
	t.Helper()
	provider, err := encryption.NewEnvKeyProvider("env:test", base64.StdEncoding.EncodeToString(bytesOf(key, 32)))
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryption.NewCipher(provider)
	if err != nil {
		t.Fatal(err)
	}
	return cipher
}

func bytesOf(value byte, n int) []byte { return []byte(strings.Repeat(string([]byte{value}), n)) }

func testDatabaseURL(raw, name string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}

func TestMigrationProcess(t *testing.T) {
	dsn := os.Getenv("SECRET_MIGRATION_PROCESS_URL")
	if dsn == "" {
		t.Skip("integration subprocess only")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := Initialize(ctx, pool, testCipher(t, 1)); err != nil {
		t.Fatal(err)
	}
}
