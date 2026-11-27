package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/boxlite-ai/secret-server/internal/attest"
	"github.com/boxlite-ai/secret-server/internal/database"
	"github.com/boxlite-ai/secret-server/internal/encryption"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

type Server struct {
	config Config
	db     *pgxpool.Pool
	http   *http.Server

	dbCloseOnce sync.Once
	dbClosed    chan struct{}
}

type startupDependencies struct {
	newCipher    func(encryption.KeyProvider) (*encryption.Cipher, error)
	encrypt      func(*encryption.Cipher, context.Context, encryption.SecretContext, []byte) (encryption.Envelope, error)
	decrypt      func(*encryption.Cipher, context.Context, encryption.SecretContext, encryption.Envelope) ([]byte, error)
	newPool      func(context.Context, *pgxpool.Config) (*pgxpool.Pool, error)
	newValidator func(context.Context) (*idtoken.Validator, error)
}

func New(ctx context.Context, c Config) (*Server, error) {
	return newServer(ctx, c, defaultStartupDependencies())
}

func defaultStartupDependencies() startupDependencies {
	return startupDependencies{
		newCipher: encryption.NewCipher,
		encrypt:   (*encryption.Cipher).Encrypt,
		decrypt:   (*encryption.Cipher).Decrypt,
		newPool:   pgxpool.NewWithConfig,
		newValidator: func(ctx context.Context) (*idtoken.Validator, error) {
			return idtoken.NewValidator(ctx, option.WithHTTPClient(&http.Client{Timeout: 5 * time.Second}))
		},
	}
}

func newServer(ctx context.Context, c Config, deps startupDependencies) (*Server, error) {
	var runnerVerifier attest.Verifier
	if c.Role == "fetch" || c.Role == "all" {
		var tokens attest.TokenVerifier
		if slices.Contains(c.RunnerAttestation.Attestors, attest.GCPIITName) {
			verifier, err := attest.NewGoogleTokenVerifier(ctx, &http.Client{Timeout: 5 * time.Second})
			if err != nil {
				return nil, errors.New("runner attestation token verifier initialization failed")
			}
			tokens = verifier
		}
		selector, err := attest.New(c.RunnerAttestation, tokens, slog.Default())
		if err != nil {
			return nil, errors.New("invalid runner attestation configuration (check SECRET_SERVER_ATTESTORS, SECRET_SERVER_RUNNER_REGISTRY and gcp_iit settings)")
		}
		runnerVerifier = selector
	}
	provider, err := encryption.NewEnvKeyProvider(c.KeyID, c.Key)
	if err != nil {
		return nil, errors.New("invalid SECRET_MASTER_KEY_ID or SECRET_MASTER_KEY_BASE64")
	}
	cipher, err := deps.newCipher(provider)
	if err != nil {
		return nil, err
	}
	value := make([]byte, 32)
	rand.Read(value)
	defer clear(value)
	identity := encryption.SecretContext{OrganizationID: "00000000-0000-4000-8000-000000000001", SecretID: "00000000-0000-4000-8000-000000000002", Version: 1, Hosts: []string{"self-test.invalid"}, Headers: map[string]string{"Authorization": "Bearer {value}"}}
	envelope, err := deps.encrypt(cipher, ctx, identity, value)
	if err != nil {
		return nil, fmt.Errorf("encryption self-test: %w", err)
	}
	plaintext, err := deps.decrypt(cipher, ctx, identity, envelope)
	if err != nil {
		return nil, fmt.Errorf("decryption self-test: %w", err)
	}
	defer clear(plaintext)
	if !bytes.Equal(value, plaintext) {
		return nil, errors.New("encryption self-test mismatch")
	}
	dbConfig, err := pgxpool.ParseConfig(c.DatabaseURL)
	if err != nil {
		return nil, errors.New("invalid DATABASE_URL")
	}
	dbConfig.MaxConns = min(dbConfig.MaxConns, 10)
	db, err := deps.newPool(ctx, dbConfig)
	if err != nil {
		return nil, databaseError(err)
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, databaseError(err)
	}
	if err := database.Initialize(ctx, db, cipher); err != nil {
		db.Close()
		return nil, errors.New("database initialization failed")
	}
	validator, err := deps.newValidator(ctx)
	if err != nil {
		db.Close()
		return nil, errors.New("token validator initialization failed")
	}
	s := &Server{config: c, db: db}
	s.http = &http.Server{Addr: net.JoinHostPort("", c.Port), Handler: routes(c, db.Ping, validator.Validate, runnerVerifier, writeRoutes(db, cipher)), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
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

func routes(c Config, ping func(context.Context) error, validate validateToken, runnerVerifier attest.Verifier, writeHandler http.Handler) http.Handler {
	mux := http.NewServeMux()
	// The fetch path is reserved separately so the write middleware never handles it.
	notFound := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { problem(w, http.StatusNotFound, "not_found") })
	var fetch http.Handler = notFound
	if runnerVerifier != nil {
		fetch = fetchAuth(runnerVerifier, fetch)
	}
	mux.Handle("/internal/v1/fetch", fetch)
	mux.Handle("/internal/v1/fetch/", fetch)
	if c.Role == "write" || c.Role == "all" {
		if writeHandler == nil {
			writeHandler = notFound
		}
		mux.Handle("/internal/v1/", writeAuth(c, validate, writeHandler))
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

func (s *Server) startDatabaseClose() bool {
	started := false
	s.dbCloseOnce.Do(func() {
		started = true
		s.dbClosed = make(chan struct{})
		go func() {
			defer close(s.dbClosed)
			s.db.Close()
		}()
	})
	return started
}

func (s *Server) waitForDatabaseClose(ctx context.Context) error {
	select {
	case <-s.dbClosed:
		return nil
	default:
	}
	select {
	case <-s.dbClosed:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("close database pool: %w", ctx.Err())
	}
}

func (s *Server) Close() error {
	// Run owns the wait once it has started pool cleanup. A deferred Close
	// after Run must not give a stalled pool another shutdown budget.
	if !s.startDatabaseClose() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.config.ShutdownTimeout)
	defer cancel()
	return s.waitForDatabaseClose(ctx)
}

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
	var serveErr error
	select {
	case serveErr = <-result:
	case <-ctx.Done():
	}

	shutdown, cancel := context.WithTimeout(context.Background(), s.config.ShutdownTimeout)
	defer cancel()
	httpErr := s.http.Shutdown(shutdown)
	if httpErr != nil {
		_ = s.http.Close()
	}
	s.startDatabaseClose()
	dbErr := s.waitForDatabaseClose(shutdown)
	if serveErr == nil {
		select {
		case serveErr = <-result:
		default:
			select {
			case serveErr = <-result:
			case <-shutdown.Done():
			}
		}
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	if httpErr == nil && dbErr == nil {
		return serveErr
	}
	return errors.Join(serveErr, httpErr, dbErr)
}
