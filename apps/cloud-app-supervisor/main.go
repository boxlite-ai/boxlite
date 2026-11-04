// Command supervisor runs inside every BoxLite Micro-cloud app Box. It starts
// the services of the current release, builds and activates new releases on
// the control plane's request, fronts the exposed service with an
// authenticated gateway, ships logs, and reaps orphans.
//
// In a Box it runs as root and runs all app code as boxlite (contracts.md
// 2.1, internal/privilege). The same binary is also the launcher at
// /usr/local/sbin/microcloud-sv, selected by argv0.
//
// Configuration comes from the environment on the first start (contracts.md
// 2.1) and from the root-only config file afterwards:
//
//	BOXLITE_CP_URL       control plane origin, e.g. https://cp.example
//	BOXLITE_BOX_TOKEN    bearer token for /sv/v1/*
//	BOXLITE_ENV_ID       environment id (informational; the token scopes requests)
//	SV_STATE_DIR         state directory when not root (default /home/boxlite/app)
//	SV_LISTEN            gateway listen address (default :8080)
//	SV_CP_INSECURE       "1" skips TLS verification towards the control plane (local tests only)
//	SV_TRUST_USER_HEADERS "1" forwards X-BoxLite-User-* set by the control plane instead of stripping them
//	SV_NO_ELEVATE        "1" stops a non-root supervisor from trying sudo (local runs)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
	"github.com/boxlite-ai/microcloud/supervisor/internal/cp"
	"github.com/boxlite-ai/microcloud/supervisor/internal/deploy"
	"github.com/boxlite-ai/microcloud/supervisor/internal/envfilter"
	"github.com/boxlite-ai/microcloud/supervisor/internal/gateway"
	"github.com/boxlite-ai/microcloud/supervisor/internal/logs"
	"github.com/boxlite-ai/microcloud/supervisor/internal/privilege"
	"github.com/boxlite-ai/microcloud/supervisor/internal/proc"
	"github.com/boxlite-ai/microcloud/supervisor/internal/state"
)

// version is injected by the Makefile via -ldflags "-X main.version=…".
var version = "dev"

type config struct {
	cpURL, token, envID string
	stateDir, listen    string
	insecure, trustUser bool

	// Set in root mode (privilege.Bootstrap).
	appDir     string
	owner      *state.Owner
	runAs      *proc.Cred
	baseEnv    []string
	root       bool
	sudoLocked bool
}

// configure decides how this process runs. As root in a Box (the app user
// exists) privilege.Bootstrap supplies the config, the root-only state dir and
// the identity for app code; otherwise everything comes from the environment
// and services run as this process.
func configure(boxPath string) (config, error) {
	if privilege.Supported() && os.Geteuid() == 0 {
		if _, _, _, ok := privilege.AppIdentity(); ok {
			res, err := privilege.Bootstrap(boxPath, log.Printf)
			if err != nil {
				return config{}, err
			}
			c := res.Config
			return config{
				cpURL: c.CPURL, token: c.Token, envID: c.EnvID,
				stateDir: privilege.RootDir, appDir: privilege.AppDir, listen: ":8080",
				insecure: c.Insecure, trustUser: c.TrustUser,
				owner:      &state.Owner{UID: res.UID, GID: res.GID},
				runAs:      &proc.Cred{UID: uint32(res.UID), GID: uint32(res.GID), Home: privilege.AppHome, Name: privilege.AppUser},
				baseEnv:    c.BaseEnv,
				root:       true,
				sudoLocked: res.SudoLocked,
			}, nil
		}
		log.Printf("running as root but user %s does not exist: services will run as root", privilege.AppUser)
	}
	c := config{
		cpURL:     os.Getenv("BOXLITE_CP_URL"),
		token:     os.Getenv("BOXLITE_BOX_TOKEN"),
		envID:     os.Getenv("BOXLITE_ENV_ID"),
		stateDir:  envOr("SV_STATE_DIR", "/home/boxlite/app"),
		listen:    envOr("SV_LISTEN", ":8080"),
		insecure:  envfilter.On(os.Getenv("SV_CP_INSECURE")),
		trustUser: envfilter.On(os.Getenv("SV_TRUST_USER_HEADERS")),
	}
	var missing []string
	for _, req := range []struct{ name, value string }{
		{"BOXLITE_CP_URL", c.cpURL}, {"BOXLITE_BOX_TOKEN", c.token}, {"BOXLITE_ENV_ID", c.envID},
	} {
		if req.value == "" {
			missing = append(missing, req.name)
		}
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("%s required", strings.Join(missing, ", "))
	}
	c.appDir = c.stateDir
	c.baseEnv = envfilter.App(os.Environ(), "")
	// Defence in depth: nothing spawned later inherits the token.
	os.Unsetenv("BOXLITE_BOX_TOKEN")
	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if privilege.IsLauncher(os.Args[0]) {
		log.SetPrefix("launcher: ")
		log.Fatalf("%v", privilege.Launch(log.Printf))
	}
	showVersion := flag.Bool("version", false, "print the version and exit")
	boxPath := flag.String("box-path", "", "the Box image's PATH, passed through sudo (which resets it)")
	flag.Parse()
	if *showVersion {
		fmt.Println("supervisor " + version)
		return
	}
	log.SetPrefix("supervisor: ")

	// Started as the app user (a Box created with the protocol-1 cmd, or a
	// manual run): become root through sudo. Returns only if that is not
	// possible, and then the supervisor runs as it was started.
	if privilege.Supported() && os.Geteuid() != 0 && !envfilter.On(os.Getenv("SV_NO_ELEVATE")) {
		if err := privilege.Elevate(*boxPath); err != nil {
			log.Printf("not root and cannot become root (%v); services will run as this user", err)
		}
	}

	cfg, err := configure(*boxPath)
	if errors.Is(err, privilege.ErrAlreadyRunning) {
		log.Printf("%v; exiting", err)
		return
	}
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	client, err := cp.New(cfg.cpURL, cfg.token, cfg.insecure)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	store, err := state.OpenSplit(cfg.stateDir, cfg.appDir, cfg.owner)
	if err != nil {
		log.Fatalf("state: %v", err)
	}

	// Signals: SIGTERM/SIGINT stop everything gracefully. As PID 1 the kernel
	// would otherwise ignore SIGTERM entirely; Go's handler makes it reach us.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// Log pipeline: hub → ring buffers + shipper → control plane.
	shipCtx, stopShipper := context.WithCancel(context.Background())
	shipper := cp.NewShipper(client)
	shipperDone := make(chan struct{})
	go func() {
		defer close(shipperDone)
		shipper.Run(shipCtx)
	}()
	hub := logs.NewHub(shipper.Emit)

	// Reaper first: nothing may be spawned before it runs.
	if err := proc.BecomeSubreaper(); err != nil {
		log.Printf("subreaper: %v (continuing; as PID 1 orphans arrive anyway)", err)
	}
	reaper := proc.NewReaper()
	reaperCtx, stopReaper := context.WithCancel(context.Background())
	go reaper.Run(reaperCtx)

	mgr := deploy.New(deploy.Options{
		CP:         client,
		Hub:        hub,
		Store:      store,
		Reaper:     reaper,
		Version:    version,
		RunAs:      cfg.runAs,
		BaseEnv:    cfg.baseEnv,
		Root:       cfg.root,
		SudoLocked: cfg.sudoLocked,
	})
	gw := gateway.New(mgr, cfg.trustUser,
		gateway.WithStaticOpener(store.OpenStatic),
		// The files endpoint reaches only the volumes the control plane's
		// spec declares, looked up with this process's own client.
		gateway.WithMounts(client.VolumeMounts),
	)
	mgr.SetGate(gw)

	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           gw,
		ReadHeaderTimeout: 15 * time.Second,
		// The CP keeps connections to the tunnel alive; idle ones must not
		// pile up. No Read/WriteTimeout: proxied apps may stream.
		IdleTimeout: 2 * time.Minute,
	}
	ln, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		log.Fatalf("gateway: %v", err)
	}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("gateway: %v", err)
		}
	}()
	hub.Systemf(0, api.LevelInfo, "gateway listening on %s (pid %d, env %s, control plane %s)", cfg.listen, os.Getpid(), cfg.envID, client.BaseURL())
	if cfg.root {
		hub.Systemf(0, api.LevelInfo, "running as root; services and builds run as %s (uid %d); sudo limited to the launcher: %v", cfg.runAs.Name, cfg.runAs.UID, cfg.sudoLocked)
	} else {
		hub.Systemf(0, api.LevelError, "running as uid %d, not root: app code can read this supervisor's state", os.Geteuid())
	}

	// Serve whatever is on disk first; reconcile with the control plane after.
	mgr.Boot(ctx)

	<-ctx.Done()
	stop()
	hub.Systemf(0, api.LevelInfo, "signal received; shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = srv.Shutdown(shutdownCtx)
	cancel()
	mgr.Shutdown()
	stopReaper()
	stopShipper()
	select {
	case <-shipperDone:
	case <-time.After(15 * time.Second):
	}
	os.Exit(0)
}
