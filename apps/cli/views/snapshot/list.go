// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package snapshot

import (
	"fmt"
	"sort"

	"github.com/boxlite-ai/boxlite/cli/views/common"
	"github.com/boxlite-ai/boxlite/cli/views/util"
	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

type RowData struct {
	Name     string
	State    string
	Resource string
	Created  string
}

func ListTemplates(templateList []apiclient.BoxTemplateDto, activeOrganizationName *string) {
	if len(templateList) == 0 {
		util.NotifyEmptyTemplateList(true)
		return
	}

	SortTemplates(&templateList)

	headers := []string{"Template", "State", "Resources", "Created"}

	data := [][]string{}

	for _, img := range templateList {
		var rowData *RowData
		var row []string

		rowData = getTableRowData(img)
		row = getRowFromRowData(*rowData)
		data = append(data, row)
	}

	table := util.GetTableView(data, headers, activeOrganizationName, func() {
		renderUnstyledList(templateList)
	})

	fmt.Println(table)
}

func SortTemplates(templateList *[]apiclient.BoxTemplateDto) {
	sort.Slice(*templateList, func(i, j int) bool {
		pi, pj := getStateSortPriorities((*templateList)[i].State, (*templateList)[j].State)
		if pi != pj {
			return pi < pj
		}

		// If two templates have the same state priority, compare the UpdatedAt property
		return (*templateList)[i].CreatedAt.After((*templateList)[j].CreatedAt)
	})
}

func getTableRowData(template apiclient.BoxTemplateDto) *RowData {
	rowData := RowData{"", "", "", ""}
	rowData.Name = template.DisplayName + util.AdditionalPropertyPadding
	rowData.State = getStateLabel(template.State)
	rowData.Resource = fmt.Sprintf("%.0f CPU / %.0f GB / %.0f GB", template.DefaultResources.Cpu, template.DefaultResources.Memory, template.DefaultResources.Disk)

	rowData.Created = util.GetTimeSinceLabel(template.CreatedAt)
	return &rowData
}

func renderUnstyledList(templateList []apiclient.BoxTemplateDto) {
	for _, template := range templateList {
		RenderInfo(&template, true)

		if template.Id != templateList[len(templateList)-1].Id {
			fmt.Printf("\n%s\n\n", common.SeparatorString)
		}
	}
}

func getRowFromRowData(rowData RowData) []string {
	row := []string{
		common.NameStyle.Render(rowData.Name),
		rowData.State,
		common.DefaultRowDataStyle.Render(rowData.Resource),
		common.DefaultRowDataStyle.Render(rowData.Created),
	}

	return row
}

func getStateSortPriorities(state1, state2 apiclient.BoxTemplateState) (int, int) {
	pi, ok := templateListStatePriorities[state1]
	if !ok {
		pi = 99
	}
	pj, ok2 := templateListStatePriorities[state2]
	if !ok2 {
		pj = 99
	}

	return pi, pj
}

// templates that have actions being performed on them have a higher priority when listing
var templateListStatePriorities = map[apiclient.BoxTemplateState]int{
	apiclient.BOXTEMPLATESTATE_PENDING:  1,
	apiclient.BOXTEMPLATESTATE_PULLING:  1,
	apiclient.BOXTEMPLATESTATE_ERROR:    2,
	apiclient.BOXTEMPLATESTATE_ACTIVE:   3,
	apiclient.BOXTEMPLATESTATE_REMOVING: 4,
}
