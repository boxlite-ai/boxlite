// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package session

import (
	"log/slog"

	"github.com/boxlite-ai/daemon/pkg/session"
)

type SessionController struct {
	logger         *slog.Logger
	configDir      string
	sessionService *session.SessionService
}

func NewSessionController(logger *slog.Logger, configDir string, sessionService *session.SessionService) *SessionController {
	return &SessionController{
		logger:         logger.With(slog.String("component", "session_controller")),
		configDir:      configDir,
		sessionService: sessionService,
	}
}
