package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type observingOutboundBody struct {
	io.ReadCloser
	read chan struct{}
}

func (b observingOutboundBody) Read(p []byte) (int, error) {
	select {
	case b.read <- struct{}{}:
	default:
	}
	return b.ReadCloser.Read(p)
}

func TestOutboundPartialPUTDoesNotHoldUpdateLock(t *testing.T) {
	tap := startNetwork(t, nil)
	reader, writer := io.Pipe()
	defer writer.Close()
	partialDone, readStarted := make(chan struct{}), make(chan struct{}, 1)
	go func() {
		defer close(partialDone)
		request := httptest.NewRequest(http.MethodPut, "/network/outbound", observingOutboundBody{ReadCloser: reader, read: readStarted})
		tap.policy.ServeHTTP(httptest.NewRecorder(), request)
	}()
	select {
	case <-readStarted:
	case <-time.After(time.Second):
		t.Fatal("partial PUT never began reading")
	}

	update := make(chan int, 1)
	go func() {
		response := httptest.NewRecorder()
		request := outboundUpdate(`{"mode":"enabled"}`, `"initial"`, "concurrent-valid")
		tap.policy.ServeHTTP(response, request)
		update <- response.Code
	}()
	select {
	case status := <-update:
		if status != http.StatusOK {
			t.Fatalf("independent PUT returned %d", status)
		}
	case <-time.After(forwardWindow):
		t.Error("partial body blocked a complete policy update")
	}
	_ = writer.Close()
	select {
	case <-partialDone:
	case <-time.After(forwardWindow):
		t.Fatal("closed partial body did not release its request")
	}
}
