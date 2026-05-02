// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package session

import (
	"errors"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

func (s *SessionService) Get(sessionId string) (*Session, error) {
	_, ok := s.sessions.Get(sessionId)
	if !ok {
		return nil, common_errors.NewNotFoundError(errors.New("session not found"))
	}

	commands, err := s.getSessionCommands(sessionId)
	if err != nil {
		return nil, err
	}

	return &Session{
		SessionId: sessionId,
		Commands:  commands,
	}, nil
}
