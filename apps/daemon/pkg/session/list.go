// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package session

import "github.com/boxlite-ai/daemon/internal/util"

func (s *SessionService) List() ([]Session, error) {
	sessions := []Session{}

	for _, sessionId := range s.sessions.Keys() {
		if sessionId == util.EntrypointSessionID {
			continue
		}

		commands, err := s.getSessionCommands(sessionId)
		if err != nil {
			return nil, err
		}

		sessions = append(sessions, Session{
			SessionId: sessionId,
			Commands:  commands,
		})
	}

	return sessions, nil
}
