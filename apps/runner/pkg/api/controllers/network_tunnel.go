package controllers

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
)

// BoxliteNetworkTunnel upgrades an authenticated CONNECT request to a raw guest stream.
func BoxliteNetworkTunnel(logger *slog.Logger) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		if ctx.Request.Method != http.MethodConnect {
			ctx.JSON(http.StatusMethodNotAllowed, gin.H{"error": "CONNECT required"})
			return
		}
		boxID := ctx.Param("boxId")
		rawPort := ctx.Query("port")
		port, err := strconv.ParseUint(rawPort, 10, 16)
		if err != nil || port == 0 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid target port %q", rawPort)})
			return
		}
		r, err := runner.GetInstance(nil)
		if err != nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		guestConn, err := r.Boxlite.DialGuestPort(ctx.Request.Context(), boxID, uint16(port))
		if err != nil {
			logger.WarnContext(ctx.Request.Context(), "guest tunnel dial failed", "box", boxID, "port", port, "error", err)
			ctx.JSON(http.StatusBadGateway, gin.H{"error": "guest tunnel unavailable"})
			return
		}

		hijacker, ok := ctx.Writer.(http.Hijacker)
		if !ok {
			guestConn.Close()
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": "connection hijacking unavailable"})
			return
		}
		clientConn, buffered, err := hijacker.Hijack()
		if err != nil {
			guestConn.Close()
			return
		}
		defer clientConn.Close()
		defer guestConn.Close()
		if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
		if err := common_proxy.ProxyBidirectionalStream(
			ctx.Request.Context(),
			common_proxy.NewBufferedConn(clientConn, buffered.Reader),
			guestConn,
		); err != nil {
			logger.WarnContext(ctx.Request.Context(), "guest tunnel stream closed with error", "box", boxID, "port", port, "error", err)
		}
	}
}
