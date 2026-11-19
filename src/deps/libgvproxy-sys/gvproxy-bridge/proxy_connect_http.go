package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"io"
	"net"
	"strconv"
	"strings"

	"golang.org/x/net/http/httpguts"
)

const proxyHeaderLimit = 32 * 1024

func connectHTTP(conn net.Conn, authority string, credential *proxyCredentials) (net.Conn, error) {
	request := "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n"
	if credential != nil {
		value := base64.StdEncoding.EncodeToString([]byte(credential.username + ":" + credential.password))
		request += "Proxy-Authorization: Basic " + value + "\r\n"
	}
	if _, err := io.WriteString(conn, request+"\r\n"); err != nil {
		return nil, proxyHandshakeFailed
	}

	headers := &io.LimitedReader{R: conn, N: proxyHeaderLimit}
	reader := bufio.NewReaderSize(headers, proxyHeaderLimit)
	for {
		status, valid := readProxyResponse(reader)
		switch {
		case !valid, status == 101:
			return nil, proxyHandshakeFailed
		case status < 200:
			continue
		case status < 300:
			// CONNECT success switches to raw bytes at the blank line.
			// Drain only the buffered prefix here, then resume at the socket.
			headers.N = 0
			return &bufferedConn{Conn: conn, reader: io.MultiReader(reader, conn)}, nil
		case status == 407:
			return nil, proxyAuthFailed
		default:
			return nil, proxyHandshakeFailed
		}
	}
}

func readProxyResponse(reader *bufio.Reader) (int, bool) {
	line, err := reader.ReadSlice('\n')
	if err != nil || !bytes.HasSuffix(line, []byte("\r\n")) {
		return 0, false
	}
	version, rest, _ := strings.Cut(string(line[:len(line)-2]), " ")
	code, reason, _ := strings.Cut(rest, " ")
	status, err := strconv.Atoi(code)
	if (version != "HTTP/1.1" && version != "HTTP/1.0") || len(code) != 3 ||
		err != nil || status < 100 || status > 599 || !httpguts.ValidHeaderFieldValue(reason) {
		return 0, false
	}
	for {
		line, err = reader.ReadSlice('\n')
		if err != nil || !bytes.HasSuffix(line, []byte("\r\n")) {
			return 0, false
		}
		if len(line) == 2 {
			return status, true
		}
		// Check field syntax without interpreting Content-Length or Transfer-Encoding.
		name, value, found := bytes.Cut(line[:len(line)-2], []byte(":"))
		if !found || !httpguts.ValidHeaderFieldName(string(name)) ||
			!httpguts.ValidHeaderFieldValue(string(value)) {
			return 0, false
		}
	}
}
