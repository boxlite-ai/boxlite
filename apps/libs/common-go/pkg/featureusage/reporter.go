// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package featureusage reports Cloud evidence independently of business traffic.
package featureusage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

const QueueCapacity = 1024
const BatchSize = 100

type Kind string

const (
	SSH              Kind = "ssh"
	TunnelConnection Kind = "tunnel_connection"
	TunnelRequest    Kind = "tunnel_request"
)

type Event struct {
	ID         string    `json:"id"`
	BoxID      string    `json:"boxId"`
	Kind       Kind      `json:"kind"`
	OccurredAt time.Time `json:"occurredAt"`
}

type Reporter struct {
	queue       chan Event
	endpoint    string
	token       string
	client      *http.Client
	logger      *slog.Logger
	dropped     atomic.Uint64
	unconfirmed atomic.Uint64
	stopped     atomic.Bool
}

func NewReporter(baseURL, token string, logger *slog.Logger) (*Reporter, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base == nil || (base.Scheme != "http" && base.Scheme != "https") ||
		base.Host == "" || base.User != nil || base.ForceQuery || base.RawQuery != "" || base.Fragment != "" ||
		token == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("invalid feature usage reporting configuration")
	}
	if logger == nil {
		logger = slog.Default()
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxConnsPerHost:       1,
		MaxIdleConns:          1,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ResponseHeaderTimeout: 2 * time.Second,
	}
	return &Reporter{
		queue:    make(chan Event, QueueCapacity),
		endpoint: strings.TrimRight(base.String(), "/") + "/telemetry/feature-usage",
		token:    token,
		logger:   logger,
		client: &http.Client{
			Transport: transport,
			Timeout:   2 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

// Record only attempts a local enqueue. It performs no network call or retry.
func (r *Reporter) Record(event Event) bool {
	if r == nil {
		return false
	}
	if r.stopped.Load() {
		r.dropped.Add(1)
		return false
	}
	if event.ID == "" {
		event.ID = uuid.NewString()
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	} else {
		event.OccurredAt = event.OccurredAt.UTC()
	}
	select {
	case r.queue <- event:
		return true
	default:
		r.dropped.Add(1)
		return false
	}
}

func (r *Reporter) Dropped() uint64     { return r.dropped.Load() }
func (r *Reporter) Unconfirmed() uint64 { return r.unconfirmed.Load() }

// Run has one owner. Delivery and diagnostics happen only on this background loop.
func (r *Reporter) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer r.client.CloseIdleConnections()
	batch := make([]Event, 0, BatchSize)
	defer func() {
		r.stopped.Store(true)
		r.dropped.Add(uint64(len(batch) + len(r.queue)))
		r.logger.Info("Cloud feature usage reporter stopped",
			"queue_dropped_total", r.Dropped(), "delivery_unconfirmed_total", r.Unconfirmed())
	}()
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := r.send(ctx, batch); err != nil {
			r.unconfirmed.Add(uint64(len(batch)))
			r.logger.Warn("Cloud feature usage delivery unconfirmed",
				"error_type", err.Error(), "delivery_unconfirmed_total", r.Unconfirmed())
		}
		batch = batch[:0]
	}
	var reportedDrops uint64
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case event := <-r.queue:
			batch = append(batch, event)
			if len(batch) == BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
			if dropped := r.Dropped(); dropped != reportedDrops {
				reportedDrops = dropped
				r.logger.Warn("Cloud feature usage queue dropped events", "queue_dropped_total", dropped)
			}
		}
	}
}

func (r *Reporter) send(ctx context.Context, events []Event) error {
	body, err := json.Marshal(struct {
		Events []Event `json:"events"`
	}{events})
	if err != nil {
		return errors.New("invalid_event")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := r.client.Do(request)
	if err != nil {
		return errors.New("transport_error")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("http_error")
	}
	return nil
}
