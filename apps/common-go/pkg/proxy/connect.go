// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"fmt"
	"net"
	"net/http"
)

// AcceptConnect takes ownership of an HTTP CONNECT response and returns its raw stream.
func AcceptConnect(writer http.ResponseWriter) (net.Conn, error) {
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		err := fmt.Errorf("connection hijacking unavailable")
		http.Error(writer, err.Error(), http.StatusInternalServerError)
		return nil, err
	}

	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("hijack CONNECT connection: %w", err)
	}
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		conn.Close()
		return nil, fmt.Errorf("write CONNECT response: %w", err)
	}
	if err := buffered.Flush(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("flush CONNECT response: %w", err)
	}

	return NewBufferedConn(conn, buffered.Reader), nil
}
