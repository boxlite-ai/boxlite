// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package box

import (
	"fmt"
	"os"
	"strings"

	"github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/charmbracelet/lipgloss"
	"golang.org/x/term"
)

func RenderInfo(box *apiclient.Box, forceUnstyled bool) {
	var output string

	output += "\n"

	output += getInfoLine("ID", box.Id) + "\n"

	if box.State != nil {
		output += getInfoLine("State", getStateLabel(*box.State)) + "\n"
	}

	output += getInfoLine("Region", box.Target) + "\n"

	if box.Class != nil {
		output += getInfoLine("Class", *box.Class) + "\n"
	}

	if box.CreatedAt != nil {
		output += getInfoLine("Created", util.GetTimeSinceLabelFromString(*box.CreatedAt)) + "\n"
	}

	if box.UpdatedAt != nil {
		output += getInfoLine("Last Event", util.GetTimeSinceLabelFromString(*box.UpdatedAt)) + "\n"
	}

	terminalWidth, _, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil {
		fmt.Println(output)
		return
	}
	if terminalWidth < common.TUITableMinimumWidth || forceUnstyled {
		renderUnstyledInfo(output)
		return
	}

	output = common.GetStyledMainTitle("Box Info") + "\n" + output

	if len(box.Labels) > 0 {
		labels := ""
		i := 0
		for k, v := range box.Labels {
			label := fmt.Sprintf("%s=%s\n", k, v)
			if i == 0 {
				labels += label + "\n"
			} else {
				labels += getInfoLine("", fmt.Sprintf("%s=%s\n", k, v))
			}
			i++
		}
		labels = strings.TrimSuffix(labels, "\n")
		output += "\n" + strings.TrimSuffix(getInfoLine("Labels", labels), "\n")
	}

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

func getStateLabel(state apiclient.BoxState) string {
	switch state {
	case apiclient.BOXSTATE_CREATING:
		return common.CreatingStyle.Render("CREATING")
	case apiclient.BOXSTATE_RESTORING:
		return common.CreatingStyle.Render("RESTORING")
	case apiclient.BOXSTATE_DESTROYED:
		return common.DeletedStyle.Render("DESTROYED")
	case apiclient.BOXSTATE_DESTROYING:
		return common.DeletedStyle.Render("DESTROYING")
	case apiclient.BOXSTATE_STARTED:
		return common.StartedStyle.Render("STARTED")
	case apiclient.BOXSTATE_STOPPED:
		return common.StoppedStyle.Render("STOPPED")
	case apiclient.BOXSTATE_STARTING:
		return common.StartingStyle.Render("STARTING")
	case apiclient.BOXSTATE_STOPPING:
		return common.StoppingStyle.Render("STOPPING")
	case apiclient.BOXSTATE_ARCHIVING:
		return common.CreatingStyle.Render("ARCHIVING")
	case apiclient.BOXSTATE_ARCHIVED:
		return common.StoppedStyle.Render("ARCHIVED")
	case apiclient.BOXSTATE_ERROR:
		return common.ErrorStyle.Render("ERROR")
	case apiclient.BOXSTATE_BUILD_FAILED:
		return common.ErrorStyle.Render("BUILD FAILED")
	case apiclient.BOXSTATE_UNKNOWN:
		return common.UndefinedStyle.Render("UNKNOWN")
	default:
		return common.UndefinedStyle.Render("/")
	}
}
