package controllers

import (
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"net/http"
)

func sshControl(ctx *gin.Context) (*sdk.SSH, error) {
	r, err := runner.GetInstance(nil)
	if err != nil {
		return nil, err
	}
	box, err := r.Boxlite.GetBox(ctx.Request.Context(), ctx.Param("boxId"))
	if err != nil {
		return nil, err
	}
	return box.SSH()
}

func BoxliteSshStatus(ctx *gin.Context) {
	ssh, err := sshControl(ctx)
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	defer ssh.Close()
	status, err := ssh.Status(ctx.Request.Context())
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, status)
}

func BoxliteSshDisable(ctx *gin.Context) {
	ssh, err := sshControl(ctx)
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	defer ssh.Close()
	status, err := ssh.Disable(ctx.Request.Context())
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, status)
}

func BoxliteSshConfigure(ctx *gin.Context) {
	var config sdk.SSHConfig
	if err := ctx.ShouldBindJSON(&config); err != nil {
		respondError(ctx, http.StatusBadRequest, "invalid SSH configuration JSON", "InvalidArgumentError", "invalid_argument")
		return
	}
	ssh, err := sshControl(ctx)
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	defer ssh.Close()
	status, err := ssh.Configure(ctx.Request.Context(), config)
	if err != nil {
		respondCopyError(ctx, err)
		return
	}
	ctx.JSON(http.StatusOK, status)
}
