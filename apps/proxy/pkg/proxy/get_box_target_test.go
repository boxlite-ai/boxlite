// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	"github.com/gin-gonic/gin"
)

type blockingActivityCache struct {
	entered  chan struct{}
	release  chan struct{}
	deadline chan time.Time
	once     sync.Once
}

func (c *blockingActivityCache) Get(context.Context, string) (*bool, error) {
	return nil, errors.New("key not found")
}

func (c *blockingActivityCache) Set(context.Context, string, bool, time.Duration) error {
	return nil
}

func (c *blockingActivityCache) Delete(context.Context, string) error {
	return nil
}

func (c *blockingActivityCache) Has(ctx context.Context, _ string) (bool, error) {
	c.once.Do(func() {
		deadline, _ := ctx.Deadline()
		c.deadline <- deadline
		close(c.entered)
	})

	select {
	case <-c.release:
		if err := ctx.Err(); err != nil {
			return false, err
		}
		return false, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

func TestGetProxyTargetUpdatesActivityAfterRequestCancellation(t *testing.T) {
	gin.SetMode(gin.TestMode)

	activityRequests := make(chan string, 1)
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		activityRequests <- r.URL.Path
		w.WriteHeader(http.StatusCreated)
	}))
	defer apiServer.Close()

	apiConfig := apiclient.NewConfiguration()
	apiConfig.Servers = apiclient.ServerConfigurations{{URL: apiServer.URL}}

	cacheCtx, cancelCaches := context.WithCancel(context.Background())
	defer cancelCaches()

	publicCache := common_cache.NewMapCache[bool](cacheCtx)
	runnerCache := common_cache.NewMapCache[RunnerInfo](cacheCtx)
	if err := publicCache.Set(cacheCtx, "box-1", true, time.Minute); err != nil {
		t.Fatalf("set public cache: %v", err)
	}
	if err := runnerCache.Set(cacheCtx, "box-1", RunnerInfo{
		ApiUrl: "http://runner.test",
		ApiKey: "runner-key",
	}, time.Minute); err != nil {
		t.Fatalf("set runner cache: %v", err)
	}

	activityCache := &blockingActivityCache{
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
		deadline: make(chan time.Time, 1),
	}
	proxy := &Proxy{
		apiclient:                  apiclient.NewAPIClient(apiConfig),
		boxPublicCache:             publicCache,
		boxRunnerCache:             runnerCache,
		boxLastActivityUpdateCache: activityCache,
	}

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "http://8000-box-1.proxy.test/", nil).WithContext(requestCtx)
	request.Host = "8000-box-1.proxy.test"

	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request
	ginCtx.Params = gin.Params{{Key: "path", Value: "/"}}

	if _, _, err := proxy.GetProxyTarget(ginCtx); err != nil {
		t.Fatalf("get proxy target: %v", err)
	}
	defer stopActivityPoll(ginCtx)

	select {
	case <-activityCache.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("activity update did not start")
	}
	deadline := <-activityCache.deadline
	remaining := time.Until(deadline)
	if deadline.IsZero() || remaining <= 0 || remaining > activityUpdateTimeout {
		t.Fatalf("unexpected activity update deadline: %v", deadline)
	}

	// Reproduce a short proxy response ending while its asynchronous activity
	// update is still in flight.
	cancelRequest()
	close(activityCache.release)

	select {
	case path := <-activityRequests:
		if path != "/box/box-1/last-activity" {
			t.Fatalf("unexpected activity endpoint: %s", path)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request cancellation prevented the activity update")
	}
}
