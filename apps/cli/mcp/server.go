// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package mcp

import (
	"github.com/boxlite-labs/boxlite/cli/mcp/tools"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type BoxliteMCPServer struct {
	server.MCPServer
}

func NewBoxliteMCPServer() *BoxliteMCPServer {
	s := &BoxliteMCPServer{}

	s.MCPServer = *server.NewMCPServer(
		"BoxLite MCP Server",
		"0.0.0-dev",
		server.WithRecovery(),
		server.WithPromptCapabilities(false),
		server.WithResourceCapabilities(false, false),
		server.WithToolCapabilities(true),
		server.WithLogging(),
	)

	s.addTools()

	return s
}

func (s *BoxliteMCPServer) Start() error {
	return server.ServeStdio(&s.MCPServer)
}

func (s *BoxliteMCPServer) addTools() {
	s.AddTool(tools.GetCreateSandboxTool(), mcp.NewTypedToolHandler(tools.CreateSandbox))
	s.AddTool(tools.GetDestroySandboxTool(), mcp.NewTypedToolHandler(tools.DestroySandbox))

	s.AddTool(tools.GetFileUploadTool(), mcp.NewTypedToolHandler(tools.FileUpload))
	s.AddTool(tools.GetFileDownloadTool(), mcp.NewTypedToolHandler(tools.FileDownload))
	s.AddTool(tools.GetFileInfoTool(), mcp.NewTypedToolHandler(tools.FileInfo))
	s.AddTool(tools.GetListFilesTool(), mcp.NewTypedToolHandler(tools.ListFiles))
	s.AddTool(tools.GetMoveFileTool(), mcp.NewTypedToolHandler(tools.MoveFile))
	s.AddTool(tools.GetDeleteFileTool(), mcp.NewTypedToolHandler(tools.DeleteFile))
	s.AddTool(tools.GetCreateFolderTool(), mcp.NewTypedToolHandler(tools.CreateFolder))

	s.AddTool(tools.GetExecuteCommandTool(), mcp.NewTypedToolHandler(tools.ExecuteCommand))
	s.AddTool(tools.GetPreviewLinkTool(), mcp.NewTypedToolHandler(tools.PreviewLink))
	s.AddTool(tools.GetGitCloneTool(), mcp.NewTypedToolHandler(tools.GitClone))
}
