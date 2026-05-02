// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package util

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/boxlite-labs/common-go/pkg/log"
)

func ReadEntrypointLogs(entrypointLogFilePath string) error {
	if entrypointLogFilePath == "" {
		return errors.New("entrypoint log file path is not configured")
	}

	logFile, err := os.Open(entrypointLogFilePath)
	if err != nil {
		return fmt.Errorf("failed to open entrypoint log file at %s: %w", entrypointLogFilePath, err)
	}
	defer logFile.Close()

	errChan := make(chan error, 1)
	stdoutChan := make(chan []byte)
	stderrChan := make(chan []byte)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go log.ReadMultiplexedLog(ctx, logFile, true, stdoutChan, stderrChan, errChan)
	for {
		select {
		case <-ctx.Done():
			return nil
		case line := <-stdoutChan:
			_, err := os.Stdout.Write(line)
			if err != nil {
				return fmt.Errorf("failed to write entrypoint log line to stdout: %w", err)
			}
		case line := <-stderrChan:
			_, err := os.Stderr.Write(line)
			if err != nil {
				return fmt.Errorf("failed to write entrypoint log line to stderr: %w", err)
			}
		case err := <-errChan:
			if err != nil {
				return err
			}
		}
	}
}
