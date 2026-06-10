// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"fmt"
	"os"

	"github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/charmbracelet/lipgloss"
	"golang.org/x/term"
)

func RenderInfo(template *apiclient.BoxTemplateDto, forceUnstyled bool) {
	var output string
	nameLabel := "Template"

	output += "\n"
	output += getInfoLine(nameLabel, template.Name) + "\n"
	output += getInfoLine("State", getStateLabel(template.State)) + "\n"

	if template.ArtifactRef != nil {
		output += getInfoLine("Artifact", *template.ArtifactRef) + "\n"
	}
	output += getInfoLine("CPU", fmt.Sprintf("%.0f cores", template.DefaultResources.Cpu)) + "\n"
	output += getInfoLine("Memory", fmt.Sprintf("%.0f GB", template.DefaultResources.Memory)) + "\n"
	output += getInfoLine("Disk", fmt.Sprintf("%.0f GB", template.DefaultResources.Disk)) + "\n"
	output += getInfoLine("Created", util.GetTimeSinceLabel(template.CreatedAt)) + "\n"

	output += getInfoLine("ID", template.Id) + "\n"

	terminalWidth, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil {
		fmt.Println(output)
		return
	}
	if terminalWidth < common.TUITableMinimumWidth || forceUnstyled {
		renderUnstyledInfo(output)
		return
	}

	output = common.GetStyledMainTitle("Template Info") + "\n" + output

	renderTUIView(output, common.GetContainerBreakpointWidth(terminalWidth))
}

func renderUnstyledInfo(output string) {
	fmt.Println(output)
}

func renderTUIView(output string, width int) {
	output = lipgloss.NewStyle().PaddingLeft(3).Render(output)

	content := lipgloss.
		NewStyle().Width(width).
		Render(output)

	fmt.Println(content)
}

func getInfoLine(key, value string) string {
	return util.PropertyNameStyle.Render(fmt.Sprintf("%-*s", util.PropertyNameWidth, key)) + util.PropertyValueStyle.Render(value) + "\n"
}

func getStateLabel(state apiclient.BoxTemplateState) string {
	switch state {
	case apiclient.BOXTEMPLATESTATE_PENDING:
		return common.CreatingStyle.Render("PENDING")
	case apiclient.BOXTEMPLATESTATE_PULLING:
		return common.CreatingStyle.Render("PULLING ARTIFACT")
	case apiclient.BOXTEMPLATESTATE_ACTIVE:
		return common.StartedStyle.Render("ACTIVE")
	case apiclient.BOXTEMPLATESTATE_ERROR:
		return common.ErrorStyle.Render("ERROR")
	case apiclient.BOXTEMPLATESTATE_BUILD_FAILED:
		return common.ErrorStyle.Render("BUILD FAILED")
	case apiclient.BOXTEMPLATESTATE_REMOVING:
		return common.DeletedStyle.Render("REMOVING")
	default:
		return common.UndefinedStyle.Render("/")
	}
}
