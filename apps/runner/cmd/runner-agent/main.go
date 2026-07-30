// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// boxlite-runner-agent installs and upgrades the runner on a runner host.
//
// It reads the desired build from SSM Parameter Store — written by `sst deploy`
// and by nothing else — and makes the box match it: at boot, and on every timer
// tick after that. A reconcile whose build is already installed is a no-op, so
// the timer is cheap.
//
// This replaced scripts/deploy/runner-update-binary.sh. The rollout is no
// longer an operator running a command against an instance; it is a
// consequence of the deploy that changed the parameter.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"

	"github.com/boxlite-ai/runner/internal"
	"github.com/boxlite-ai/runner/internal/rollout"
)

const usage = `boxlite-runner-agent — reconcile this host's runner build to the desired state

Usage:
  boxlite-runner-agent reconcile     install/upgrade the runner to the desired build
  boxlite-runner-agent version       print the agent version

Environment:
  BOXLITE_AGENT_PARAMETER   SSM parameter holding the desired state (required)
  BOXLITE_AGENT_REGION      AWS region (required)
  BOXLITE_AGENT_SERVICE     systemd unit to manage (default: boxlite-runner)
`

func main() {
	if err := run(); err != nil {
		slog.Error("reconcile failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		return errors.New("no command given")
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(internal.Version)
		return nil
	case "reconcile":
	case "-h", "--help", "help":
		fmt.Print(usage)
		return nil
	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", os.Args[1])
	}

	parameter := os.Getenv("BOXLITE_AGENT_PARAMETER")
	if parameter == "" {
		return errors.New("BOXLITE_AGENT_PARAMETER is required")
	}
	region := os.Getenv("BOXLITE_AGENT_REGION")
	if region == "" {
		return errors.New("BOXLITE_AGENT_REGION is required")
	}
	service := os.Getenv("BOXLITE_AGENT_SERVICE")
	if service == "" {
		service = "boxlite-runner"
	}

	// Bounded so a hung download cannot hold the systemd unit open forever;
	// the unit's TimeoutStartSec is the outer backstop.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}

	host, err := rollout.NewHost(service)
	if err != nil {
		return err
	}

	reconciler := rollout.NewReconciler(
		rollout.NewParameterSource(cfg, parameter),
		rollout.NewFetcher(cfg),
		host,
		log,
	)
	return reconciler.Reconcile(ctx)
}
