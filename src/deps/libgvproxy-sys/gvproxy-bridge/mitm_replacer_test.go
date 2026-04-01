package main

import (
	"bytes"
	"io"
	"math/rand"
	"runtime"
	"strings"
	"testing"
)

// --- Helper types ---

// limitedReader wraps an io.Reader and returns at most n bytes per Read call.
type limitedReader struct {
	r io.Reader
	n int
}

func (lr *limitedReader) Read(p []byte) (int, error) {
	if len(p) > lr.n {
		p = p[:lr.n]
	}
	return lr.r.Read(p)
}

// trackingCloser records whether Close() was called.
type trackingCloser struct {
	r      io.Reader
	closed bool
}

func (tc *trackingCloser) Read(p []byte) (int, error) {
	return tc.r.Read(p)
}

func (tc *trackingCloser) Close() error {
	tc.closed = true
	return nil
}

// --- Helper functions ---

func makeSecrets(pairs ...string) []SecretConfig {
	var secrets []SecretConfig
	for i := 0; i+1 < len(pairs); i += 2 {
		secrets = append(secrets, SecretConfig{
			Name:        pairs[i],
			Placeholder: pairs[i],
			Value:       pairs[i+1],
		})
	}
	return secrets
}

func assertBytesEqual(t *testing.T, expected, actual []byte, msg string) {
	t.Helper()
	if !bytes.Equal(expected, actual) {
		// Truncate output for large bodies
		expStr := string(expected)
		actStr := string(actual)
		if len(expStr) > 200 {
			expStr = expStr[:200] + "...(truncated)"
		}
		if len(actStr) > 200 {
			actStr = actStr[:200] + "...(truncated)"
		}
		t.Errorf("%s\nexpected: %q\nactual:   %q", msg, expStr, actStr)
	}
}

// --- Basic functionality ---

func TestStreamingReplacer_NilBody(t *testing.T) {
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	result := newStreamingReplacer(nil, secrets)
	if result != nil {
		t.Error("expected nil when body is nil")
	}
}

func TestStreamingReplacer_NoSecrets(t *testing.T) {
	body := io.NopCloser(strings.NewReader("hello"))
	result := newStreamingReplacer(body, []SecretConfig{})
	if result != body {
		t.Error("expected original body returned when secrets is empty")
	}
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte("hello"), data, "body content should be unchanged")
}

func TestStreamingReplacer_EmptyBody(t *testing.T) {
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	body := io.NopCloser(strings.NewReader(""))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) != 0 {
		t.Errorf("expected 0 bytes, got %d", len(data))
	}
}

func TestStreamingReplacer_NoPlaceholderPresent(t *testing.T) {
	input := "just a normal request body"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(input), data, "output should be identical byte-for-byte")
}

// --- Single placeholder ---

func TestStreamingReplacer_SingleInSmallBody(t *testing.T) {
	input := `{"auth":"<BOXLITE_SECRET:openai>"}`
	expected := `{"auth":"sk-real-key-123"}`
	secrets := []SecretConfig{{
		Name:        "openai",
		Placeholder: "<BOXLITE_SECRET:openai>",
		Value:       "sk-real-key-123",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder should be replaced")
}

func TestStreamingReplacer_PlaceholderAtStart(t *testing.T) {
	input := "<BOXLITE_SECRET:key>rest of body"
	expected := "sk-123rest of body"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder at start should be replaced")
}

func TestStreamingReplacer_PlaceholderAtEnd(t *testing.T) {
	input := "body prefix <BOXLITE_SECRET:key>"
	expected := "body prefix sk-123"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder at end should be replaced")
}

func TestStreamingReplacer_PlaceholderIsEntireBody(t *testing.T) {
	input := "<BOXLITE_SECRET:key>"
	expected := "sk-123"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "sk-123",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder as entire body should be replaced")
}

// --- Multiple placeholders ---

func TestStreamingReplacer_MultipleSamePlaceholder(t *testing.T) {
	input := "<BOXLITE_SECRET:k> and <BOXLITE_SECRET:k> again"
	expected := "val and val again"
	secrets := []SecretConfig{{
		Name:        "k",
		Placeholder: "<BOXLITE_SECRET:k>",
		Value:       "val",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "same placeholder should be replaced multiple times")
}

func TestStreamingReplacer_MultipleDifferentSecrets(t *testing.T) {
	input := "key1=<BOXLITE_SECRET:a>&key2=<BOXLITE_SECRET:b>"
	expected := "key1=val-a&key2=val-b"
	secrets := []SecretConfig{
		{Name: "a", Placeholder: "<BOXLITE_SECRET:a>", Value: "val-a"},
		{Name: "b", Placeholder: "<BOXLITE_SECRET:b>", Value: "val-b"},
	}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "different placeholders should each be replaced")
}

func TestStreamingReplacer_AdjacentPlaceholders(t *testing.T) {
	input := "<BOXLITE_SECRET:a><BOXLITE_SECRET:b>"
	expected := "val-aval-b"
	secrets := []SecretConfig{
		{Name: "a", Placeholder: "<BOXLITE_SECRET:a>", Value: "val-a"},
		{Name: "b", Placeholder: "<BOXLITE_SECRET:b>", Value: "val-b"},
	}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "adjacent placeholders should both be replaced")
}

// --- Boundary spanning ---

func TestStreamingReplacer_BoundarySpan(t *testing.T) {
	// Use a reader that returns exactly 16 bytes per Read.
	// Place placeholder so it spans across the 16-byte boundary.
	placeholder := "<BOXLITE_SECRET:key>"
	value := "sk-replaced"
	// 10 bytes of padding + 20-byte placeholder = placeholder starts at offset 10, spans bytes 10-29
	input := "0123456789" + placeholder + "tail"
	expected := "0123456789" + value + "tail"

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}
	lr := &limitedReader{r: strings.NewReader(input), n: 16}
	body := io.NopCloser(lr)
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder spanning chunk boundary should be replaced")
}

func TestStreamingReplacer_BoundaryAtOverlapEdge(t *testing.T) {
	// Place placeholder at exactly (chunkSize - maxPlaceholder + 1)
	placeholder := "<BOXLITE_SECRET:key>"
	value := "replaced-value"
	maxPH := len(placeholder)
	offset := replacerBufSize - maxPH + 1

	var buf bytes.Buffer
	// Write padding up to offset
	for buf.Len() < offset {
		buf.WriteByte('A')
	}
	buf.WriteString(placeholder)
	buf.WriteString("end")

	input := buf.String()
	expectedOutput := strings.Repeat("A", offset) + value + "end"

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}

	// Use a reader that returns chunks of replacerBufSize
	lr := &limitedReader{r: strings.NewReader(input), n: replacerBufSize}
	body := io.NopCloser(lr)
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expectedOutput), data, "placeholder at overlap edge should be replaced")
}

func TestStreamingReplacer_OneByteReads(t *testing.T) {
	placeholder := "<BOXLITE_SECRET:key>"
	value := "secret-val"
	input := "before" + placeholder + "after"
	expected := "before" + value + "after"

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}
	lr := &limitedReader{r: strings.NewReader(input), n: 1}
	body := io.NopCloser(lr)
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "one-byte reads should still produce correct substitution")
}

// --- Large bodies ---

func TestStreamingReplacer_LargeBody100MB(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping large body test in short mode")
	}

	placeholder := "<BOXLITE_SECRET:key>"
	value := "sk-replaced-value"
	totalSize := 100 * 1024 * 1024 // 100MB
	placeholderOffset := 50 * 1024 * 1024

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}

	// Custom reader that generates data on the fly without allocating full buffer
	pr, pw := io.Pipe()
	go func() {
		written := 0
		chunk := bytes.Repeat([]byte("X"), 64*1024)
		for written < totalSize {
			if written <= placeholderOffset && written+len(chunk) > placeholderOffset {
				// Write up to placeholder offset
				before := placeholderOffset - written
				if before > 0 {
					pw.Write(chunk[:before])
					written += before
				}
				pw.Write([]byte(placeholder))
				written += len(placeholder)
				continue
			}
			remaining := totalSize - written
			if remaining < len(chunk) {
				chunk = chunk[:remaining]
			}
			pw.Write(chunk)
			written += len(chunk)
		}
		pw.Close()
	}()

	result := newStreamingReplacer(pr, secrets)

	// Read in fixed-size chunks to avoid io.ReadAll's doubling allocations.
	// We only keep the last 1MB to verify the substitution happened while
	// measuring that the replacer itself uses constant memory.
	var memBefore, memAfter runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&memBefore)

	chunk := make([]byte, 256*1024) // 256KB read buffer
	totalRead := 0
	foundValue := false
	foundPlaceholder := false
	tail := make([]byte, 0, 1024*1024) // keep last 1MB for verification

	for {
		n, err := result.Read(chunk)
		if n > 0 {
			totalRead += n
			// Check this chunk for placeholder/value
			if bytes.Contains(chunk[:n], []byte(value)) {
				foundValue = true
			}
			if bytes.Contains(chunk[:n], []byte(placeholder)) {
				foundPlaceholder = true
			}
			// Keep tail for final verification
			tail = append(tail, chunk[:n]...)
			if len(tail) > 1024*1024 {
				tail = tail[len(tail)-1024*1024:]
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}

	runtime.GC()
	runtime.ReadMemStats(&memAfter)

	// Verify substitution happened
	expectedLen := totalSize - len(placeholder) + len(value)
	if totalRead != expectedLen {
		t.Errorf("expected length %d, got %d", expectedLen, totalRead)
	}

	if foundPlaceholder {
		t.Error("placeholder should have been replaced in output")
	}
	if !foundValue {
		t.Error("replacement value should be present in output")
	}

	// Now we can accurately measure: heap growth should be just the replacer
	// internals (~64KB buffer + overlap), not the full output.
	heapGrowth := int64(memAfter.HeapInuse) - int64(memBefore.HeapInuse)
	if heapGrowth > 2*1024*1024 {
		t.Errorf("replacer heap overhead exceeded 2MB: %d bytes", heapGrowth)
	}
}

func TestStreamingReplacer_LargeBodyPlaceholderInFirst1KB(t *testing.T) {
	placeholder := "<BOXLITE_SECRET:key>"
	value := "replaced"
	// 100 bytes of prefix + placeholder + padding to 1MB
	prefix := strings.Repeat("A", 100)
	remaining := 1024*1024 - 100 - len(placeholder)
	input := prefix + placeholder + strings.Repeat("B", remaining)
	expected := prefix + value + strings.Repeat("B", remaining)

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "placeholder in first 1KB of large body should be replaced")
}

func TestStreamingReplacer_LargeBodyNoPlaceholder(t *testing.T) {
	size := 10 * 1024 * 1024 // 10MB
	input := strings.Repeat("X", size)
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) != size {
		t.Errorf("expected output length %d, got %d", size, len(data))
	}
}

// --- Edge cases ---

func TestStreamingReplacer_UnconfiguredPlaceholderName(t *testing.T) {
	input := "<BOXLITE_SECRET:not_configured>"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(input), data, "unconfigured placeholder should remain unchanged")
}

func TestStreamingReplacer_BrokenPrefix(t *testing.T) {
	input := "<BOXLITE_SECRE"
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(input), data, "broken prefix should remain unchanged")
}

func TestStreamingReplacer_BinaryBody(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	binData := make([]byte, 4096)
	rng.Read(binData)

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	body := io.NopCloser(bytes.NewReader(binData))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, binData, data, "binary body should pass through unchanged")
}

func TestStreamingReplacer_ReplacementLonger(t *testing.T) {
	placeholder := "<BOXLITE_SECRET:key>" // 20 chars
	value := strings.Repeat("X", 100)     // 100 chars
	input := "before" + placeholder + "after"
	expected := "before" + value + "after"

	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: placeholder,
		Value:       value,
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "longer replacement should produce correct output")
	expectedLen := len("before") + 100 + len("after")
	if len(data) != expectedLen {
		t.Errorf("expected output length %d, got %d", expectedLen, len(data))
	}
}

func TestStreamingReplacer_ReplacementShorter(t *testing.T) {
	placeholder := "<BOXLITE_SECRET:a]_long_name_here>" // 34 chars > 30
	value := "abc"                                      // 3 chars
	input := "before" + placeholder + "after"
	expected := "before" + value + "after"

	secrets := []SecretConfig{{
		Name:        "a",
		Placeholder: placeholder,
		Value:       value,
	}}
	body := io.NopCloser(strings.NewReader(input))
	result := newStreamingReplacer(body, secrets)
	data, err := io.ReadAll(result)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertBytesEqual(t, []byte(expected), data, "shorter replacement should produce correct output")
	expectedLen := len("before") + 3 + len("after")
	if len(data) != expectedLen {
		t.Errorf("expected output length %d, got %d", expectedLen, len(data))
	}
}

func TestStreamingReplacer_ClosePropagates(t *testing.T) {
	tc := &trackingCloser{r: strings.NewReader("hello")}
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	result := newStreamingReplacer(tc, secrets)
	err := result.Close()
	if err != nil {
		t.Fatalf("unexpected error on Close: %v", err)
	}
	if !tc.closed {
		t.Error("Close should propagate to underlying reader")
	}
}

func TestStreamingReplacer_ReadAfterClose(t *testing.T) {
	secrets := []SecretConfig{{
		Name:        "key",
		Placeholder: "<BOXLITE_SECRET:key>",
		Value:       "val",
	}}
	body := io.NopCloser(strings.NewReader("hello <BOXLITE_SECRET:key> world"))
	result := newStreamingReplacer(body, secrets)
	result.Close()
	buf := make([]byte, 100)
	_, err := result.Read(buf)
	if err == nil {
		t.Error("Read after Close should return an error")
	}
}
