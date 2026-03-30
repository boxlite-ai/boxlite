package main

import (
	"bytes"
	"io"
	"strings"
)

const replacerBufSize = 64 * 1024

// SecretConfig holds a secret's placeholder mapping for substitution.
type SecretConfig struct {
	Name        string   `json:"name"`
	Hosts       []string `json:"hosts"`
	Placeholder string   `json:"placeholder"`
	Value       string   `json:"value"`
}

func (s SecretConfig) String() string {
	return "SecretConfig{Name:" + s.Name + ", Placeholder:" + s.Placeholder + ", Value:[REDACTED]}"
}

type streamingReplacer struct {
	src            io.ReadCloser
	replacer       *strings.Replacer
	buf            []byte // internal read buffer for boundary handling
	bufLen         int    // valid bytes in buf
	maxPlaceholder int
	prefixBytes    []byte // first byte of each unique placeholder (for boundary detection)

	// overflow holds replaced output that didn't fit in the caller's buffer.
	overflow []byte
	overPos  int

	srcDone bool
	closed  bool
}

// newStreamingReplacer wraps body with streaming placeholder substitution.
// Returns body unchanged if secrets is empty or body is nil.
func newStreamingReplacer(body io.ReadCloser, secrets []SecretConfig) io.ReadCloser {
	if body == nil || len(secrets) == 0 {
		return body
	}

	maxPH := 0
	pairs := make([]string, 0, len(secrets)*2)
	seen := make(map[byte]bool)
	for _, s := range secrets {
		pairs = append(pairs, s.Placeholder, s.Value)
		if len(s.Placeholder) > maxPH {
			maxPH = len(s.Placeholder)
		}
		if len(s.Placeholder) > 0 {
			seen[s.Placeholder[0]] = true
		}
	}
	prefixBytes := make([]byte, 0, len(seen))
	for b := range seen {
		prefixBytes = append(prefixBytes, b)
	}

	return &streamingReplacer{
		src:            body,
		replacer:       strings.NewReplacer(pairs...),
		buf:            make([]byte, replacerBufSize+maxPH),
		maxPlaceholder: maxPH,
		prefixBytes:    prefixBytes,
	}
}

func (s *streamingReplacer) Read(p []byte) (int, error) {
	if s.closed {
		return 0, io.ErrClosedPipe
	}

	// Drain overflow from previous call
	if s.overPos < len(s.overflow) {
		n := copy(p, s.overflow[s.overPos:])
		s.overPos += n
		if s.overPos >= len(s.overflow) {
			s.overflow = s.overflow[:0]
			s.overPos = 0
		}
		return n, nil
	}

	if s.srcDone && s.bufLen == 0 {
		return 0, io.EOF
	}

	// Read from src until we have enough data to emit safely.
	// Never return (0, nil) — that violates io.Reader expectations and
	// causes io.ReadAll to spin.
	for {
		if !s.srcDone {
			n, err := s.src.Read(s.buf[s.bufLen:])
			s.bufLen += n
			if err == io.EOF {
				s.srcDone = true
			} else if err != nil {
				return 0, err
			}
		}

		if s.bufLen == 0 {
			return 0, io.EOF
		}

		if s.srcDone {
			// Final chunk: replace and emit all
			replaced := s.replacer.Replace(string(s.buf[:s.bufLen]))
			s.bufLen = 0
			n := copy(p, replaced)
			if n < len(replaced) {
				s.overflow = append(s.overflow[:0], replaced[n:]...)
				s.overPos = 0
			} else if len(s.overflow) == 0 {
				return n, io.EOF
			}
			return n, nil
		}

		safeEnd := s.safeBoundary()
		if safeEnd > 0 {
			break // enough data — proceed to replacement
		}
		// Not enough data yet — loop to read more from src
	}

	safeEnd := s.safeBoundary()

	safe := s.buf[:safeEnd]
	var n int

	if !s.containsPrefixByte(safe) {
		// Fast path: no placeholder prefix byte found, copy raw bytes directly
		n = copy(p, safe)
		if n < safeEnd {
			s.overflow = append(s.overflow[:0], safe[n:]...)
			s.overPos = 0
		}
	} else {
		// Slow path: run replacer
		replaced := s.replacer.Replace(string(safe))
		n = copy(p, replaced)
		if n < len(replaced) {
			s.overflow = append(s.overflow[:0], replaced[n:]...)
			s.overPos = 0
		}
	}

	// Shift remaining bytes to front of buffer
	remaining := s.bufLen - safeEnd
	copy(s.buf, s.buf[safeEnd:s.bufLen])
	s.bufLen = remaining

	return n, nil
}

// safeBoundary returns the number of bytes from the start of buf that can
// safely be replaced and emitted.
func (s *streamingReplacer) safeBoundary() int {
	if s.bufLen <= s.maxPlaceholder-1 {
		return 0
	}

	dangerStart := s.bufLen - (s.maxPlaceholder - 1)
	danger := s.buf[dangerStart:s.bufLen]
	// Return the earliest occurrence of any prefix byte in the danger zone.
	minIdx := len(danger)
	for _, b := range s.prefixBytes {
		if idx := bytes.IndexByte(danger, b); idx >= 0 && idx < minIdx {
			minIdx = idx
		}
	}
	if minIdx < len(danger) {
		return dangerStart + minIdx
	}
	return s.bufLen
}

// containsPrefixByte checks if data contains any placeholder first byte.
func (s *streamingReplacer) containsPrefixByte(data []byte) bool {
	for _, b := range s.prefixBytes {
		if bytes.IndexByte(data, b) >= 0 {
			return true
		}
	}
	return false
}

func (s *streamingReplacer) Close() error {
	s.closed = true
	if s.src != nil {
		return s.src.Close()
	}
	return nil
}
