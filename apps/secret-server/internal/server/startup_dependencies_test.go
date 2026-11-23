package server

import (
	"context"
	"encoding/base64"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/boxlite-ai/secret-server/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/puddle/v2"
	"google.golang.org/api/idtoken"
)

func TestStartupDependencyFailures(t *testing.T) {
	cause := errors.New("injected failure")
	config := Config{KeyID: "env:test", Key: base64.StdEncoding.EncodeToString(make([]byte, 32)), DatabaseURL: "postgres://localhost/test"}
	for _, tc := range []struct {
		name      string
		configure func(*startupDependencies)
		want      string
		wrapped   bool
	}{
		{"cipher constructor", func(d *startupDependencies) {
			d.newCipher = func(encryption.KeyProvider) (*encryption.Cipher, error) { return nil, cause }
		}, "injected failure", true},
		{"encrypt", func(d *startupDependencies) {
			d.encrypt = func(*encryption.Cipher, context.Context, encryption.SecretContext, []byte) (encryption.Envelope, error) {
				return encryption.Envelope{}, cause
			}
		}, "encryption self-test", true},
		{"decrypt", func(d *startupDependencies) {
			d.decrypt = func(*encryption.Cipher, context.Context, encryption.SecretContext, encryption.Envelope) ([]byte, error) {
				return nil, cause
			}
		}, "decryption self-test", true},
		{"mismatch", func(d *startupDependencies) {
			d.decrypt = func(*encryption.Cipher, context.Context, encryption.SecretContext, encryption.Envelope) ([]byte, error) {
				return []byte("incorrect"), nil
			}
		}, "encryption self-test mismatch", false},
		{"pool constructor", func(d *startupDependencies) {
			d.newPool = func(context.Context, *pgxpool.Config) (*pgxpool.Pool, error) {
				return nil, &net.OpError{Op: "dial", Net: "tcp", Err: cause}
			}
		}, "database network connection failed", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := defaultStartupDependencies()
			tc.configure(&deps)
			s, err := newServer(context.Background(), config, deps)
			if s != nil || err == nil || !strings.Contains(err.Error(), tc.want) || (tc.wrapped && !errors.Is(err, cause)) {
				t.Fatalf("startup = %v, %v; want %q", s, err, tc.want)
			}
		})
	}
}

func TestStartupClosesPoolWhenValidatorConstructionFails(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SECRET_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	_, databaseURL := testdb.Create(t, ctx, admin, dsn, false)
	config := Config{KeyID: "env:test", Key: base64.StdEncoding.EncodeToString(make([]byte, 32)), DatabaseURL: databaseURL}
	deps := defaultStartupDependencies()
	var pool *pgxpool.Pool
	deps.newPool = func(ctx context.Context, config *pgxpool.Config) (*pgxpool.Pool, error) {
		var err error
		pool, err = pgxpool.NewWithConfig(ctx, config)
		return pool, err
	}
	deps.newValidator = func(context.Context) (*idtoken.Validator, error) { return nil, errors.New("sensitive detail") }
	s, err := newServer(ctx, config, deps)
	if s != nil || err == nil || err.Error() != "token validator initialization failed" {
		t.Fatalf("startup = %v, %v", s, err)
	}
	if pool == nil || !errors.Is(pool.Ping(ctx), puddle.ErrClosedPool) {
		t.Fatal("startup did not close the database pool")
	}
}
