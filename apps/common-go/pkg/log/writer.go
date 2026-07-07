// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: Apache-2.0

package log

import (
	"log/slog"
)

type InfoLogWriter struct{}

func (w *InfoLogWriter) Write(p []byte) (n int, err error) {
	slog.Info(string(p))
	return len(p), nil
}

type ErrorLogWriter struct{}

func (w *ErrorLogWriter) Write(p []byte) (n int, err error) {
	slog.Error(string(p))
	return len(p), nil
}
