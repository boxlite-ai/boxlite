package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

type Server struct {
	config Config
	db     *sql.DB
	http   *http.Server
}

func New(ctx context.Context, c Config) (*Server, error) {
	provider, err := encryption.NewEnvKeyProvider(c.KeyID, c.Key)
	if err != nil {
		return nil, errors.New("invalid SECRET_MASTER_KEY_ID or SECRET_MASTER_KEY_BASE64")
	}
	cipher, err := encryption.NewCipher(provider)
	if err != nil {
		return nil, err
	}
	value := make([]byte, 32)
	rand.Read(value)
	defer clear(value)
	identity := encryption.SecretContext{OrganizationID: "00000000-0000-4000-8000-000000000001", SecretID: "00000000-0000-4000-8000-000000000002", Version: 1, Hosts: []string{"self-test.invalid"}, Headers: map[string]string{"Authorization": "Bearer {value}"}}
	envelope, err := cipher.Encrypt(ctx, identity, value)
	if err != nil {
		return nil, fmt.Errorf("encryption self-test: %w", err)
	}
	plaintext, err := cipher.Decrypt(ctx, identity, envelope)
	if err != nil {
		return nil, fmt.Errorf("decryption self-test: %w", err)
	}
	defer clear(plaintext)
	if !bytes.Equal(value, plaintext) {
		return nil, errors.New("encryption self-test mismatch")
	}
	db, err := sql.Open("pgx", c.DatabaseURL)
	if err != nil {
		return nil, errors.New("invalid DATABASE_URL")
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, databaseError(err)
	}
	// Migration and durable canary verification are integration stubs for #2571.
	// Both must succeed before readiness once their implementations are wired in.
	if err := migrationCheck(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	if err := canaryCheck(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	slog.Warn("migration and durable canary checks are not implemented")
	validator, err := idtoken.NewValidator(ctx, option.WithHTTPClient(&http.Client{Timeout: 5 * time.Second}))
	if err != nil {
		db.Close()
		return nil, errors.New("token validator initialization failed")
	}
	s := &Server{config: c, db: db}
	s.http = &http.Server{Addr: net.JoinHostPort("", c.Port), Handler: routes(c, db.PingContext, validator.Validate), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	return s, nil
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	var netErr net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("database connection timed out")
	case errors.Is(err, context.Canceled):
		return errors.New("database connection canceled")
	case errors.As(err, &pgErr):
		if len(pgErr.Code) == 5 {
			for _, c := range pgErr.Code {
				if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'Z') {
					return errors.New("database connection rejected")
				}
			}
			return fmt.Errorf("database connection rejected (SQLSTATE %s)", pgErr.Code)
		}
		return errors.New("database connection rejected")
	case errors.As(err, &netErr):
		return errors.New("database network connection failed")
	default:
		return errors.New("database connection failed")
	}
}

func routes(c Config, ping func(context.Context) error, validate validateToken) http.Handler {
	mux := http.NewServeMux()
	// Endpoint implementations are supplied by their respective follow-up work.
	// The fetch path is reserved separately so the write middleware never handles it.
	notFound := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { problem(w, http.StatusNotFound, "not_found") })
	mux.Handle("/internal/v1/fetch", notFound)
	mux.Handle("/internal/v1/fetch/", notFound)
	if c.Role == "write" || c.Role == "all" {
		mux.Handle("/internal/v1/", writeAuth(c, validate, notFound))
	}
	mux.Handle("/", notFound)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			problem(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			problem(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if ping(ctx) != nil {
			problem(w, http.StatusServiceUnavailable, "not_ready")
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return recoverRequests(mux)
}

func migrationCheck(context.Context, *sql.DB) error { return nil }
func canaryCheck(context.Context, *sql.DB) error    { return nil }

func (s *Server) Close() error { return s.db.Close() }

func recoverRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				if value == http.ErrAbortHandler {
					panic(value)
				}
				slog.Error("request panic")
				problem(w, http.StatusInternalServerError, "internal_error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Run(ctx context.Context, listener net.Listener) error {
	result := make(chan error, 1)
	go func() { result <- s.http.Serve(listener) }()
	select {
	case err := <-result:
		s.db.Close()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), s.config.ShutdownTimeout)
		defer cancel()
		err := s.http.Shutdown(shutdown)
		if err != nil {
			_ = s.http.Close()
		}
		serveErr := <-result
		dbErr := s.db.Close()
		if err != nil {
			return err
		}
		if !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
		return dbErr
	}
}
