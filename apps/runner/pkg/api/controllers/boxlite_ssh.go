package controllers

import (
	"context"
	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"net/http"
)

type sshOperations interface {
	Status(context.Context) (*sdk.SSHStatus, error)
	Disable(context.Context) (*sdk.SSHStatus, error)
	Configure(context.Context, sdk.SSHConfig) (*sdk.SSHStatus, error)
	Close() error
}

type sshController struct {
	acquire func(*gin.Context) (sshOperations, error)
}

func sshControl(ctx *gin.Context) (sshOperations, error) {
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
	sshController{acquire: sshControl}.status(ctx)
}

func (controller sshController) status(ctx *gin.Context) {
	ssh, err := controller.acquire(ctx)
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
	sshController{acquire: sshControl}.disable(ctx)
}

func (controller sshController) disable(ctx *gin.Context) {
	ssh, err := controller.acquire(ctx)
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
	sshController{acquire: sshControl}.configure(ctx)
}

func (controller sshController) configure(ctx *gin.Context) {
	var config sdk.SSHConfig
	if err := ctx.ShouldBindJSON(&config); err != nil {
		respondError(ctx, http.StatusBadRequest, "invalid SSH configuration JSON", "InvalidArgumentError", "invalid_argument")
		return
	}
	ssh, err := controller.acquire(ctx)
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
