// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/boxlite-ai/proxy/internal"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/securecookie"

	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"

	log "github.com/sirupsen/logrus"
)

type RunnerInfo struct {
	ApiUrl string `json:"apiUrl"`
	ApiKey string `json:"apiKey"`
}

const BOX_AUTH_KEY_HEADER = "X-BoxLite-Preview-Token"
const BOX_AUTH_KEY_QUERY_PARAM = "BOXLITE_BOX_AUTH_KEY"
const BOX_AUTH_COOKIE_NAME = "boxlite-box-auth-"
const TERMINAL_PORT = "22222"

type Proxy struct {
	config       *config.Config
	secureCookie *securecookie.SecureCookie
	cookieDomain *string

	apiclient            *apiclient.APIClient
	runnerCache          common_cache.ICache[RunnerInfo]
	boxRunnerCache       common_cache.ICache[RunnerInfo]
	boxPublicCache       common_cache.ICache[bool]
	boxAuthKeyValidCache common_cache.ICache[bool]
}

func StartProxy(ctx context.Context, config *config.Config) error {
	proxy := &Proxy{
		config: config,
	}

	proxy.secureCookie = securecookie.New([]byte(config.ProxyApiKey), nil)
	if config.CookieDomain != nil {
		cookieDomain := GetCookieDomainFromHost(*config.CookieDomain)
		proxy.cookieDomain = &cookieDomain
	}

	proxy.apiclient = config.ApiClient

	if config.Redis != nil {
		var err error
		proxy.boxRunnerCache, err = common_cache.NewRedisCache[RunnerInfo](config.Redis, "proxy:box-runner-info:")
		if err != nil {
			return err
		}
		proxy.runnerCache, err = common_cache.NewRedisCache[RunnerInfo](config.Redis, "proxy:runner-info:")
		if err != nil {
			return err
		}
		proxy.boxPublicCache, err = common_cache.NewRedisCache[bool](config.Redis, "proxy:box-public:")
		if err != nil {
			return err
		}
		proxy.boxAuthKeyValidCache, err = common_cache.NewRedisCache[bool](config.Redis, "proxy:box-auth-key-valid:")
		if err != nil {
			return err
		}
	} else {
		proxy.boxRunnerCache = common_cache.NewMapCache[RunnerInfo](ctx)
		proxy.runnerCache = common_cache.NewMapCache[RunnerInfo](ctx)
		proxy.boxPublicCache = common_cache.NewMapCache[bool](ctx)
		proxy.boxAuthKeyValidCache = common_cache.NewMapCache[bool](ctx)
	}

	shutdownWg := &sync.WaitGroup{}

	router := gin.New()
	router.Use(func(ctx *gin.Context) {
		shutdownWg.Add(1)

		cleanupOnce := sync.Once{}
		cleanup := func() {
			cleanupOnce.Do(func() {
				shutdownWg.Done()
			})
		}

		// Wrap the response writer to monitor connection
		monitor := &common_proxy.ConnectionMonitor{
			ResponseWriter: ctx.Writer,
			OnConnClosed:   cleanup,
		}
		ctx.Writer = monitor

		// For non-WebSocket connections, cleanup on defer
		defer cleanup()

		common_errors.Recovery()(ctx)
	})

	router.Use(common_errors.NewErrorMiddleware(func(ctx *gin.Context, err error) common_errors.ErrorResponse {
		return common_errors.ErrorResponse{
			StatusCode: http.StatusInternalServerError,
			Message:    err.Error(),
		}
	}))

	router.Use(func(ctx *gin.Context) {
		if ctx.Request.Header.Get("X-BoxLite-Disable-CORS") == "true" {
			ctx.Request.Header.Del("X-BoxLite-Disable-CORS")
			return
		}

		corsConfig := cors.DefaultConfig()
		corsConfig.AllowOriginFunc = func(origin string) bool {
			return true
		}
		corsConfig.AllowCredentials = true
		corsConfig.AllowHeaders = slices.Collect(maps.Keys(ctx.Request.Header))
		corsConfig.AllowHeaders = append(corsConfig.AllowHeaders, ctx.Request.Header.Values("Access-Control-Request-Headers")...)

		cors.New(corsConfig)(ctx)
	})

	if config.PreviewWarningEnabled {
		router.Use(proxy.browserWarningMiddleware())
	}

	router.Any("/*path", func(ctx *gin.Context) {
		if ctx.Request.Method == "POST" && ctx.Request.URL.Path == ACCEPT_PREVIEW_PAGE_WARNING_PATH {
			handleAcceptProxyWarning(ctx, config.ProxyProtocol == "https")
			return
		}

		_, _, _, err := proxy.parseHost(ctx.Request.Host)
		// if the host is not valid, we don't proxy the request
		if err != nil {
			switch ctx.Request.Method {
			case "GET":
				{
					switch ctx.Request.URL.Path {
					case "/callback":
						proxy.AuthCallback(ctx)
						return
					case "/health":
						ctx.JSON(http.StatusOK, gin.H{"status": "ok", "version": internal.Version})
						return
					}
				}
			}

			ctx.Error(common_errors.NewNotFoundError(errors.New("not found")))
			return
		}

		common_proxy.NewProxyRequestHandler(proxy.GetProxyTarget, nil)(ctx)
	})

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", config.ProxyPort),
		Handler:           connectAwareHandler(http.HandlerFunc(proxy.handleTunnelConnect), router, shutdownWg),
		ReadHeaderTimeout: 10 * time.Second,
	}

	listener, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return err
	}

	log.Infof("Proxy server is running on port %d", config.ProxyPort)

	serveErr := make(chan error, 1)
	go func() {
		if config.EnableTLS {
			serveErr <- httpServer.ServeTLS(listener, config.TLSCertFile, config.TLSKeyFile)
		} else {
			serveErr <- httpServer.Serve(listener)
		}
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
		errChan := make(chan error, 1)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Duration(config.ShutdownTimeoutSec)*time.Second)
		defer cancel()

		go func() {
			err := httpServer.Shutdown(shutdownCtx)
			if err != nil {
				errChan <- err
				return
			}

			wgChan := make(chan struct{})

			go func() {
				log.Info("Waiting for active requests to finish...")
				shutdownWg.Wait()
				log.Info("All active requests finished, shutting down proxy")
				close(wgChan)
			}()

			select {
			case <-shutdownCtx.Done():
				errChan <- fmt.Errorf("shutdown timeout reached, forcing exit")
			case <-wgChan:
				errChan <- nil
			}

			errChan <- nil
		}()

		return <-errChan
	}
}

func connectAwareHandler(connectHandler, next http.Handler, shutdownWg *sync.WaitGroup) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodConnect {
			shutdownWg.Add(1)
			defer shutdownWg.Done()
			connectHandler.ServeHTTP(writer, request)
			return
		}
		next.ServeHTTP(writer, request)
	})
}
