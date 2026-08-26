// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.)
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: Apache-2.0

package errors

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// Recovery must hand http.ErrAbortHandler back to net/http. If it swallows the
// panic (as it used to), net/http finishes the response cleanly and a client
// reading a half-written streaming body sees a clean EOF — indistinguishable
// from a whole body. Severing the connection is the only way to say "this is
// not the whole thing".
func TestRecoveryRepanicsErrAbortHandler(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(Recovery())
	r.GET("/abort", func(c *gin.Context) {
		c.Header("Content-Type", "application/x-tar")
		// Enough to exceed net/http's 2 KiB auto-buffer so the response is
		// chunked and the abort severs a body already on the wire.
		_, _ = c.Writer.Write(make([]byte, 64*1024))
		c.Writer.Flush()
		panic(http.ErrAbortHandler)
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/abort")
	if err != nil {
		// Connection reset before a response completed is the transport signal.
		return
	}
	defer resp.Body.Close()

	_, readErr := io.ReadAll(resp.Body)
	if readErr == nil {
		t.Fatalf("Recovery() swallowed http.ErrAbortHandler: client read a clean body")
	}
}
